/**
 * Defects found by a Codex review (2026-10-06) and reproduced here. Each test states the
 * behaviour the proposal in docs/proposals/subscriber-key-dead-letter-ack.md asks for, so each one
 * fails on 0.1.3 and passes with the proposal.
 *
 * 1. Re-subscribing re-keys an existing subscription: on a public monitor, anyone who knows a
 *    subscriber's name could take its subscription, cursor and all, and lock its holder out.
 * 2. A dead letter was only a word in the log: the subject could be claimed again.
 * 3. The `watch` command acknowledged what it had only printed: an event printed to a session that
 *    then died was lost.
 * 4. (K3.1) A subscription could claim a subject that only another monitor published. Once dead
 *    letters are permanent, any monitor's subscription could kill such a subject for all of them.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { MonitorService } from "../server/core.js";
import { createHttpServer, listen } from "../server/http.js";
import { MemoryStore } from "../store.js";
import type { Monitor, PullResult, Subscription } from "../types.js";

function fixture() {
  const service = new MonitorService(new MemoryStore());
  const created = service.createMonitor({ id: "m1", name: "m1", horizon: "minute", capabilities: ["observe", "react", "act"], visibility: "public", types: ["t.reading"] });
  const { monitor, owner_token } = created.body as { monitor: Monitor; owner_token: string };
  return { service, monitor, owner: owner_token };
}
function subscribe(service: MonitorService, monitor: string, subscriber: string, capabilities = ["observe"], grant?: string) {
  const r = service.subscribe({ monitor, subscriber, capabilities }, { bearer: grant ?? null });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body as { subscription: Subscription; token: string };
}

test("K3-1: re-subscribing an existing subscriber needs its current token or the owner's", async () => {
  const { service, monitor, owner } = fixture();
  const alice = subscribe(service, monitor.id, "agent:alice");

  // A stranger who only knows the name, with no token, is refused, and alice keeps her key.
  const stranger = service.subscribe({ monitor: monitor.id, subscriber: "agent:alice", capabilities: ["observe"] }, { bearer: null });
  assert.equal(stranger.status, 401, JSON.stringify(stranger.body));
  assert.equal((stranger.body as { code: string }).code, "UNAUTHORIZED");
  assert.equal((await service.pull(alice.subscription.id, {}, { bearer: alice.token })).status, 200, "alice's token must still work");

  // Another subscriber's token is not alice's either.
  const bob = subscribe(service, monitor.id, "agent:bob");
  const withBobs = service.subscribe({ monitor: monitor.id, subscriber: "agent:alice", capabilities: ["observe"] }, { bearer: bob.token });
  assert.equal(withBobs.status, 401, JSON.stringify(withBobs.body));

  // Alice herself may re-subscribe: the token rotates and the subscription is the same one.
  const renewed = service.subscribe({ monitor: monitor.id, subscriber: "agent:alice", capabilities: ["observe"] }, { bearer: alice.token });
  assert.equal(renewed.status, 201, JSON.stringify(renewed.body));
  const fresh = renewed.body as { subscription: Subscription; token: string };
  assert.equal(fresh.subscription.id, alice.subscription.id);
  assert.equal((await service.pull(alice.subscription.id, {}, { bearer: alice.token })).status, 401, "the old token stops working");
  assert.equal((await service.pull(alice.subscription.id, {}, { bearer: fresh.token })).status, 200);

  // The monitor's owner may re-key it, for a subscriber that lost its token.
  const byOwner = service.subscribe({ monitor: monitor.id, subscriber: "agent:alice", capabilities: ["observe"] }, { bearer: owner });
  assert.equal(byOwner.status, 201, JSON.stringify(byOwner.body));
});

test("K3-2: a dead-lettered subject cannot be claimed again", () => {
  const { service, monitor, owner } = fixture();
  const w1 = subscribe(service, monitor.id, "agent:w1", ["observe", "act"], owner);
  const w2 = subscribe(service, monitor.id, "agent:w2", ["observe", "act"], owner);
  assert.equal(service.monitorAction(monitor.id, "observations", { type: "t.reading", subject: "job-1", data: {} }, { bearer: owner }).status, 201);
  const lease = (s: { subscription: Subscription; token: string }, action: string) =>
    service.leaseAction(s.subscription.id, action, { subject: "job-1", reason: "cannot process" }, { bearer: s.token });

  let last: { dead_letter?: boolean } = {};
  for (let i = 0; i < 5; i++) {
    assert.equal(lease(w1, "claim").status, 201);
    const r = lease(w1, "reject");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    last = r.body as { dead_letter?: boolean };
  }
  assert.equal(last.dead_letter, true, "the fifth reject reaches delivery_count_limit");

  for (const s of [w2, w1]) {
    const again = lease(s, "claim");
    assert.equal(again.status, 409, `a dead letter was claimed again: ${JSON.stringify(again.body)}`);
    assert.equal((again.body as { code: string }).code, "DEAD_LETTERED");
  }
});

test("K3-4: a subscription claims only what its own monitor published, so no other monitor can dead-letter it", () => {
  const { service, monitor, owner } = fixture();
  const other = service.createMonitor({ id: "m2", name: "m2", horizon: "minute", capabilities: ["observe", "act"], visibility: "public", types: ["t.reading"] });
  const { monitor: m2, owner_token: owner2 } = other.body as { monitor: Monitor; owner_token: string };
  assert.equal(service.monitorAction(monitor.id, "observations", { type: "t.reading", subject: "job-1", data: {} }, { bearer: owner }).status, 201);
  const mine = subscribe(service, monitor.id, "agent:worker", ["observe", "act"], owner);
  const foreign = subscribe(service, m2.id, "agent:intruder", ["observe", "act"], owner2);
  const lease = (s: { subscription: Subscription; token: string }, action: string) =>
    service.leaseAction(s.subscription.id, action, { subject: "job-1", reason: "cannot process" }, { bearer: s.token });

  // A subscription to a monitor that never published job-1 cannot claim it, so it can neither hold
  // it nor reject it into a dead letter, however many times it tries.
  for (let i = 0; i < 6; i++) {
    const r = lease(foreign, "claim");
    assert.equal(r.status, 404, `a foreign claim was accepted: ${JSON.stringify(r.body)}`);
    assert.equal((r.body as { code: string }).code, "NOT_FOUND");
    assert.equal(lease(foreign, "reject").status, 409);
  }
  // job-1 stays deliverable to its own monitor's subscriptions.
  assert.equal(lease(mine, "claim").status, 201);
  assert.equal((lease(mine, "complete").body as { ok?: boolean }).ok, true);

  // The work-item model is kept: a monitor that publishes the same subject delivers the same work
  // item, so its subscriptions contend for it. (Who may create monitors is what limits this: attested
  // servers, `--registration-token`.)
  assert.equal(service.monitorAction(m2.id, "observations", { type: "t.reading", subject: "job-2", data: {} }, { bearer: owner2 }).status, 201);
  assert.equal(service.monitorAction(monitor.id, "observations", { type: "t.reading", subject: "job-2", data: {} }, { bearer: owner }).status, 201);
  assert.equal(service.leaseAction(foreign.subscription.id, "claim", { subject: "job-2" }, { bearer: foreign.token }).status, 201);
  assert.equal(service.leaseAction(mine.subscription.id, "claim", { subject: "job-2" }, { bearer: mine.token }).status, 409);
});

test("K3-4b: the published index survives compaction and a restart from state", () => {
  const store = new MemoryStore();
  const service = new MonitorService(store);
  const created = service.createMonitor({ id: "m1", name: "m1", horizon: "minute", capabilities: ["observe", "act"], visibility: "public", types: ["t.reading"] });
  const { monitor, owner_token: owner } = created.body as { monitor: Monitor; owner_token: string };
  assert.equal(service.monitorAction(monitor.id, "observations", { type: "t.reading", subject: "old-job", data: {} }, { bearer: owner }).status, 201);
  store.compact(store.head());                      // the publication row itself is gone from the log
  const again = new MemoryStore();
  again.load(JSON.parse(JSON.stringify(store.snapshot())));
  assert.equal(again.hasPublished(monitor.id, "old-job"), true);
  // and a state written before the index existed is rebuilt from the rows still in its log
  const legacy = JSON.parse(JSON.stringify(store.snapshot()));
  delete legacy.published;
  legacy.events = [{ seq: 99, time: new Date().toISOString(), monitor: monitor.id, type: "t.reading", subject: "kept-job", actor: "x", tier: "measured", origin: "probe", verification: "none", horizon: "minute", data: {}, provenance: {} }];
  const rebuilt = new MemoryStore();
  rebuilt.load(legacy);
  assert.equal(rebuilt.hasPublished(monitor.id, "kept-job"), true);
  assert.equal(rebuilt.hasPublished(monitor.id, "old-job"), false);
});

const cli = fileURLToPath(new URL("../index.js", import.meta.url));
const run = (args: string[]) => new Promise<string>((resolve, reject) =>
  execFile(process.execPath, [cli, ...args], { timeout: 20_000 }, (e, out, errOut) => e ? reject(new Error(`${e.message}\n${errOut}`)) : resolve(out)));

test("K3-3: `watch` prints without acknowledging; the session acknowledges after handling", async () => {
  const { service, monitor, owner } = fixture();
  const server = createHttpServer(service, {});
  const bound = await listen(server, 0);
  after(() => bound.close());
  const made = service.subscribe({ monitor: monitor.id, subscriber: "agent:session", capabilities: ["observe"], filter: { types: ["t.reading"] } }, { bearer: null });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const sub = made.body as { subscription: Subscription; token: string };
  assert.equal(service.monitorAction(monitor.id, "observations", { type: "t.reading", data: { i: 1 } }, { bearer: owner }).status, 201);

  const printed = await run(["watch", "--base", bound.url, "--subscription", sub.subscription.id, "--token", sub.token, "--wait", "0", "--once"]);
  assert.match(printed, /^OBS seq=/m);

  // The session that printed it may die before handling it: the event must still be there.
  const again = (await service.pull(sub.subscription.id, {}, { bearer: sub.token })).body as PullResult;
  assert.equal(again.observations.length, 1, "what was only printed was acknowledged");
  assert.equal(again.observations[0].redelivered, true);

  // After handling, the session acknowledges what `watch` told it to.
  const next = /^NEXT (\d+)$/m.exec(printed);
  assert.ok(next, `watch must print the cursor to acknowledge:\n${printed}`);
  await run(["ack", "--base", bound.url, "--subscription", sub.subscription.id, "--token", sub.token, "--cursor", next[1]]);
  const after_ = (await service.pull(sub.subscription.id, {}, { bearer: sub.token })).body as PullResult;
  assert.equal(after_.observations.length, 0);
});
