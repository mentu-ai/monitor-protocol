import assert from "node:assert/strict";
import { test } from "node:test";
import { MonitorService } from "../server/core.js";
import { MemoryStore } from "../store.js";
import type { Monitor, Observation, PullResult, State, Subscription } from "../types.js";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function fixture() {
  const service = new MonitorService(new MemoryStore());
  const created = service.createMonitor({ id: "m1", name: "m1", horizon: "minute", capabilities: ["observe", "react", "act"], visibility: "public", types: ["t.reading"] });
  const { monitor, owner_token } = created.body as { monitor: Monitor; owner_token: string };
  return { service, monitor, owner: owner_token };
}
function subscribe(service: MonitorService, monitor: string, subscriber: string, capabilities = ["observe"], extra: Record<string, unknown> = {}) {
  const r = service.subscribe({ monitor, subscriber, capabilities, ...extra }, { bearer: null });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const { subscription, token } = r.body as { subscription: Subscription; token: string };
  return { sub: subscription, token };
}

test("publish, pull twice, ack once: the cursor moves only on ack", async () => {
  const { service, monitor, owner } = fixture();
  const { sub, token } = subscribe(service, monitor.id, "agent:a");
  for (let i = 0; i < 3; i++) assert.equal(service.monitorAction(monitor.id, "observations", { type: "t.reading", data: { i } }, { bearer: owner }).status, 201);
  const first = await service.pull(sub.id, {}, { bearer: token });
  const again = await service.pull(sub.id, {}, { bearer: token });
  const a = first.body as PullResult, b = again.body as PullResult;
  assert.deepEqual(a.observations.map(o => o.id), b.observations.map(o => o.id));
  assert.equal(a.cursor, 0);
  assert.equal(service.subAction(sub.id, "ack", { cursor: a.next }, { bearer: token }).status, 200);
  const backwards = service.subAction(sub.id, "ack", { cursor: a.next - 1 }, { bearer: token });
  assert.equal(backwards.status, 409);
  assert.equal((backwards.body as { code: string }).code, "CURSOR_BACKWARDS");
  const repeat = service.subAction(sub.id, "ack", { cursor: a.next }, { bearer: token });
  assert.equal(repeat.status, 200);
  const after = await service.pull(sub.id, {}, { bearer: token });
  assert.equal((after.body as PullResult).observations.length, 0);
});

test("an agent cannot assert tier src, and the refusal is itself an observation", async () => {
  const { service, monitor, owner } = fixture();
  const r = service.monitorAction(monitor.id, "observations", { type: "t.reading", tier: "src", origin: "agent" }, { bearer: owner });
  assert.equal(r.status, 400);
  assert.equal((r.body as { code: string }).code, "TIER_NOT_ASSERTABLE");
  const { sub, token } = subscribe(service, monitor.id, "agent:witness");
  const page = (await service.pull(sub.id, { limit: 100 }, { bearer: token })).body as PullResult;
  const rejected = page.observations.filter(o => o.type === "ai.mentu.monitor.rejected");
  assert.equal(rejected.length, 1);
  assert.equal(((rejected[0].data.payload as Record<string, unknown>).raw as Record<string, unknown>).tier, "src");
});

test("one holder wins a lease; an expired lease is lost, not stolen silently", async () => {
  const { service, monitor } = fixture();
  const a = subscribe(service, monitor.id, "agent:a", ["observe", "act"]);
  const b = subscribe(service, monitor.id, "agent:b", ["observe", "act"]);
  const first = service.leaseAction(a.sub.id, "claim", { subject: "s1", lease_duration_seconds: 60 }, { bearer: a.token });
  const second = service.leaseAction(b.sub.id, "claim", { subject: "s1", lease_duration_seconds: 60 }, { bearer: b.token });
  assert.equal(first.status, 201);
  assert.equal(second.status, 409);
  assert.equal((second.body as { code: string; holder: string }).code, "LEASE_HELD");
  assert.equal((second.body as { holder: string }).holder, "sub:" + a.sub.id);
  assert.equal(service.leaseAction(a.sub.id, "claim", { subject: "s1" }, { bearer: a.token }).status, 200);

  assert.equal(service.leaseAction(a.sub.id, "claim", { subject: "s2", lease_duration_seconds: 1 }, { bearer: a.token }).status, 201);
  await sleep(1200);
  assert.equal(service.leaseAction(b.sub.id, "claim", { subject: "s2", lease_duration_seconds: 60 }, { bearer: b.token }).status, 201);
  const late = service.leaseAction(a.sub.id, "complete", { subject: "s2" }, { bearer: a.token });
  assert.equal(late.status, 409);
  assert.equal((late.body as { code: string }).code, "LEASE_LOST");
});

test("observe-only cannot act", () => {
  const { service, monitor } = fixture();
  const { sub, token } = subscribe(service, monitor.id, "agent:reader");
  const r = service.leaseAction(sub.id, "claim", { subject: "s1" }, { bearer: token });
  assert.equal(r.status, 403);
  assert.equal((r.body as { code: string }).code, "CAPABILITY_MISSING");
});

test("every configuration change is an observation with its action", async () => {
  const { service, monitor, owner } = fixture();
  const { sub, token } = subscribe(service, monitor.id, "agent:witness", ["observe"], { filter: { types: ["ai.mentu.monitor.*"] } });
  for (const action of ["pause", "resume", "retire"]) assert.equal(service.monitorAction(monitor.id, action, { reason: "test" }, { bearer: owner }).status, 200);
  const page = (await service.pull(sub.id, { limit: 100 }, { bearer: token })).body as PullResult;
  const actions = page.observations.filter(o => o.type === "ai.mentu.monitor.configured").map(o => (o.data.payload as { action: string }).action);
  assert.deepEqual(actions, ["create", "pause", "resume", "retire"]);
});

test("state names its missing inputs instead of defaulting a number", () => {
  const { service, monitor, owner } = fixture();
  service.monitorAction(monitor.id, "observations", { type: "t.reading", data: {} }, { bearer: owner });
  const s = service.state(monitor.id, { bearer: null }).body as State;
  assert.equal(s.confidence.value, null);
  assert.ok(s.confidence.inputs.missing.length > 0);
  assert.ok(s.confidence.gaps.includes("independence_unknown"));
  assert.ok(s.confidence.gaps.includes("no_subscribers"));
  assert.equal(s.live.value, true);
  assert.equal(typeof s.covers_until, "string");
});

test("a cursor below the retention floor is expired, not silently reset", async () => {
  const { service, monitor, owner } = fixture();
  const { sub, token } = subscribe(service, monitor.id, "agent:a");
  for (let i = 0; i < 3; i++) service.monitorAction(monitor.id, "observations", { type: "t.reading", data: { i } }, { bearer: owner });
  service.store.compact(service.store.head() - 1);
  const r = await service.pull(sub.id, { cursor: 0 }, { bearer: token });
  assert.equal(r.status, 410);
  assert.equal((r.body as { code: string }).code, "CURSOR_EXPIRED");
  assert.ok((r.body as { retention_floor: number }).retention_floor > 1);
});

test("a mute subscription is retired with a will event and keeps its cursor", async () => {
  const { service, monitor, owner } = fixture();
  const { sub, token } = subscribe(service, monitor.id, "agent:mute", ["observe"], { retire_after_mute_seconds: 1 });
  service.monitorAction(monitor.id, "observations", { type: "t.reading", data: {} }, { bearer: owner });
  const page = (await service.pull(sub.id, {}, { bearer: token })).body as PullResult;
  service.subAction(sub.id, "ack", { cursor: page.next }, { bearer: token });
  await sleep(1200);
  assert.equal(service.sweep(), 1);
  const gone = await service.pull(sub.id, {}, { bearer: token });
  assert.equal(gone.status, 404);
  assert.equal((gone.body as unknown as { retired: boolean }).retired, true);
  const back = service.subscribe({ monitor: monitor.id, subscriber: "agent:mute", capabilities: ["observe"] }, { bearer: null });
  assert.equal((back.body as { subscription: Subscription }).subscription.cursor, page.next);
  assert.equal((back.body as { subscription: Subscription }).subscription.id, sub.id);
});

test("an inline filter narrows and refuses to widen", async () => {
  const { service, monitor, owner } = fixture();
  service.monitorAction(monitor.id, "observations", { type: "t.reading", data: {} }, { bearer: owner });
  const { sub, token } = subscribe(service, monitor.id, "agent:a", ["observe"], { filter: { types: ["t.reading"] } });
  const widened = await service.pull(sub.id, { filter: { types: ["ai.mentu.monitor.configured"] } }, { bearer: token });
  assert.equal(widened.status, 400);
  assert.equal((widened.body as { code: string }).code, "INVALID_FILTER");
  const narrowed = await service.pull(sub.id, { filter: { tiers: ["measured"] } }, { bearer: token });
  assert.equal(narrowed.status, 200);
});

test("a private monitor is invisible without its owner token", () => {
  const service = new MonitorService(new MemoryStore());
  const r = service.createMonitor({ id: "priv", name: "priv", horizon: "day", capabilities: ["observe"], visibility: "private" });
  const owner = (r.body as { owner_token: string }).owner_token;
  assert.equal(((service.listMonitors({ bearer: null }).body as { monitors: Monitor[] }).monitors).length, 0);
  assert.equal(((service.listMonitors({ bearer: owner }).body as { monitors: Monitor[] }).monitors).length, 1);
  assert.equal(service.getMonitor("priv", { bearer: null }).status, 404);
});

test("observations carry a 20-digit sequence that sorts like the integer", async () => {
  const { service, monitor, owner } = fixture();
  const { sub, token } = subscribe(service, monitor.id, "agent:a");
  for (let i = 0; i < 12; i++) service.monitorAction(monitor.id, "observations", { type: "t.reading", data: { i } }, { bearer: owner });
  const page = (await service.pull(sub.id, { limit: 100 }, { bearer: token })).body as PullResult;
  const seqs = page.observations.map((o: Observation) => o.sequence);
  assert.ok(seqs.every(s => /^\d{20}$/.test(s)));
  assert.deepEqual(seqs, [...seqs].sort());
});
