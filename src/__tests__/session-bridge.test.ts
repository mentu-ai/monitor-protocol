import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeJournal, SessionBridge, deliveryNotification, type SessionAdapter, type SessionSource } from "../session/bridge.js";
import { HttpSubscriptionSource } from "../session/source.js";
import { MonitorService } from "../server/core.js";
import { createHttpServer, listen } from "../server/http.js";
import { MemoryStore } from "../store.js";
import type { Observation, Subscription } from "../types.js";

const observation = (data = { secret: "event-content-not-a-notification" }): Observation => ({
  source: "urn:example:monitor", id: "00000000000000000007", sequence: "00000000000000000007",
  type: "com.example.change", specversion: "1.0", time: new Date().toISOString(),
  tier: "measured", origin: "probe", verified: "indeterminate", actor: "test", horizon: "minute", data,
} as unknown as Observation);

function fixture(t: { after(fn: () => void): void }) {
  const path = mkdtempSync(join(tmpdir(), "mp-bridge-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  let live = true;
  let event: Observation | null = observation();
  const messages: string[] = [], acknowledgements: number[] = [];
  const source: SessionSource = {
    base: "https://example.invalid", subscription: "one",
    pull: async () => event ? { event, next: 8 } : null,
    acknowledge: async cursor => { acknowledgements.push(cursor); event = null; },
  };
  const adapter: SessionAdapter = { kind: "test", binding: { thread: "already-open" },
    isLive: async () => live, enqueue: async message => { messages.push(message); } };
  const journal = new BridgeJournal(path, { version: 1, adapter: adapter.kind, binding: adapter.binding,
    source: { base: source.base, subscription: source.subscription } });
  const worker = () => new SessionBridge(new BridgeJournal(path), source, adapter, ["monitor-protocol"]);
  return { path, journal, source, adapter, messages, acknowledgements, worker,
    kill: () => { live = false; }, change: () => { event = observation({ secret: "changed" }); } };
}

test("delivery queues metadata only, persists handling before ack, survives worker restart", async t => {
  const f = fixture(t);
  assert.equal(await f.worker().step(), "queued");
  const item = f.journal.pending()!;
  assert.match(f.messages[0], new RegExp(item.fingerprint));
  assert.ok(!f.messages[0].includes(item.event.data.secret as string));
  assert.deepEqual(f.acknowledgements, []);
  assert.equal(await f.worker().step(), "waiting-for-handling");
  assert.equal(f.messages.length, 1);
  f.journal.handle(item.id, "No action required; observed under existing task.");
  assert.equal(await f.worker().step(), "acknowledged");
  assert.deepEqual(f.acknowledgements, [8]);
  assert.equal(new BridgeJournal(f.path).pending(), null);
  assert.equal(await f.worker().step(), "idle");
  assert.equal(statSync(join(f.path, "binding.json")).mode & 0o777, 0o600);
});

test("uncertain enqueue redelivers the same delivery id, never implicitly acknowledges", async t => {
  const f = fixture(t);
  const real = f.adapter.enqueue;
  f.adapter.enqueue = async message => { await real(message); throw new Error("crash after durable queue acceptance"); };
  await assert.rejects(f.worker().step(), /crash/);
  const first = f.journal.pending()!;
  f.adapter.enqueue = real;
  assert.equal(await f.worker().step(), "queued");
  assert.equal(f.journal.pending()!.id, first.id);
  assert.equal(f.messages[0], f.messages[1]);
  assert.deepEqual(f.acknowledgements, []);
});

test("crash after handling resumes acknowledgement without another wake", async t => {
  const f = fixture(t);
  await f.worker().step();
  const item = f.journal.pending()!;
  f.journal.handle(item.id, "record:7");
  const real = f.source.acknowledge;
  f.source.acknowledge = async () => { throw new Error("network lost"); };
  await assert.rejects(f.worker().step(), /network lost/);
  assert.equal(f.journal.pending()!.id, item.id);
  f.source.acknowledge = real;
  assert.equal(await f.worker().step(), "acknowledged");
  assert.equal(f.messages.length, 1);
});

test("lost ack response retries idempotent ack from the receipt", async t => {
  const f = fixture(t);
  await f.worker().step();
  f.journal.handle(f.journal.pending()!.id, "attended");
  const real = f.source.acknowledge;
  f.source.acknowledge = async cursor => { await real(cursor); throw new Error("response lost"); };
  await assert.rejects(f.worker().step(), /response lost/);
  f.source.acknowledge = real;
  assert.equal(await f.worker().step(), "acknowledged");
  assert.deepEqual(f.acknowledgements, [8, 8]);
  assert.equal(f.messages.length, 1);
});

test("session death or explicit stop prevents delivery and pending acknowledgement", async t => {
  for (const end of ["death", "stop"]) {
    const f = fixture(t);
    await f.worker().step();
    f.journal.handle(f.journal.pending()!.id, "attended");
    end === "death" ? f.kill() : f.journal.stop();
    assert.equal(await f.worker().step(), "stopped");
    assert.deepEqual(f.acknowledgements, []);
    assert.equal(f.messages.length, 1);
  }
});

test("different session/source cannot rebind or steal a state directory", async t => {
  const f = fixture(t);
  const header = f.journal.header();
  assert.throws(() => new BridgeJournal(f.path, { ...header, binding: { thread: "new" } }), /different/);
  assert.throws(() => new SessionBridge(f.journal, { ...f.source, subscription: "another" }, f.adapter, []), /differs/);
  assert.deepEqual(f.journal.header(), header);
});

test("changed event or cursor while awaiting handling fails closed", async t => {
  const f = fixture(t);
  await f.worker().step();
  f.change();
  await assert.rejects(f.worker().step(), /subscription changed/);
  assert.deepEqual(f.acknowledgements, []);
});

test("delivery and receipt corruption cannot acknowledge", async t => {
  for (const kind of ["delivery", "receipt"]) {
    const f = fixture(t);
    await f.worker().step();
    const item = f.journal.pending()!;
    f.journal.handle(item.id, "attended");
    const path = join(f.path, `${kind}-${item.id}.json`);
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (kind === "delivery") data.event.data = { forged: true };
    else data.fingerprint = "sha256:wrong";
    writeFileSync(path, JSON.stringify(data));
    await assert.rejects(f.worker().step(), /changed|receipt/);
    assert.deepEqual(f.acknowledgements, []);
  }
});

test("deduplication keeps one receipt and refuses contradictory dispositions", async t => {
  const f = fixture(t);
  await f.worker().step();
  const item = f.journal.pending()!;
  const first = f.journal.handle(item.id, "no action needed");
  assert.deepEqual(f.journal.handle(item.id, "no action needed"), first);
  assert.throws(() => f.journal.handle(item.id, "different"), /different/);
  assert.throws(() => f.journal.handle(item.id, " "), /requires/);
  assert.throws(() => f.journal.get("../../escape"), /invalid delivery/);
});

test("one worker per state; lock never steals an ambiguous or killed worker lock", t => {
  const f = fixture(t);
  const release = f.journal.lock();
  assert.throws(() => new BridgeJournal(f.path).lock(), /worker lock exists/);
  release();
  f.journal.lock()();
});

test("notification quotes installation/state paths and excludes observation-supplied commands", async t => {
  const f = fixture(t);
  await f.worker().step();
  const text = deliveryNotification(f.journal, f.journal.pending()!, ["/tmp/a 'quoted' path/node", "/tmp/index.js"]);
  assert.ok(text.includes("'/tmp/a '\\''quoted'\\'' path/node'"));
  assert.ok(text.includes("not new user authorization"));
  assert.ok(!text.includes("event-content-not-a-notification"));
});

test("a backward wall-clock adjustment does not poison a durable handling receipt", async t => {
  const f = fixture(t);
  await f.worker().step();
  const item = f.journal.pending()!;
  const RealDate = Date;
  const earlier = RealDate.parse(item.created) - 10_000;
  // This synchronous section cannot overlap another test in this file. Restore before awaiting.
  globalThis.Date = class extends RealDate {
    constructor() { super(earlier); }
  } as unknown as DateConstructor;
  try {
    const receipt = f.journal.handle(item.id, "Attended despite an operating-system clock adjustment");
    assert.ok(RealDate.parse(receipt.handled) < RealDate.parse(item.created));
  } finally { globalThis.Date = RealDate; }
  assert.ok(new BridgeJournal(f.path).receipt(item.id), "the durable receipt remains valid after clock recovery");
  assert.equal(await f.worker().step(), "acknowledged");
  assert.deepEqual(f.acknowledgements, [8]);
});

test("real HTTP subscription through durable journal queues, handles, and acknowledges in order", async t => {
  const path = mkdtempSync(join(tmpdir(), "mp-bridge-http-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const service = new MonitorService(new MemoryStore());
  const created = service.createMonitor({ id: "bridge-integration", name: "Bridge integration",
    horizon: "event", visibility: "public", capabilities: ["observe"], types: ["com.example.changed"] });
  const { owner_token } = created.body as { owner_token: string };
  const subscribed = service.subscribe({ monitor: "bridge-integration", subscriber: "agent:integration",
    capabilities: ["observe"], filter: { types: ["com.example.changed"] } }, {});
  const { subscription, token } = subscribed.body as { subscription: Subscription; token: string };
  assert.equal(service.monitorAction("bridge-integration", "observations", {
    type: "com.example.changed", data: { ref: "record:7", text: "untrusted-payload-only-on-show" },
  }, { bearer: owner_token }).status, 201);
  const bound = await listen(createHttpServer(service), 0);
  t.after(() => bound.close());
  const source = new HttpSubscriptionSource(bound.url, subscription.id, token);
  const messages: string[] = [];
  const adapter: SessionAdapter = {
    kind: "test-live-session", binding: { thread: "existing-human-session" },
    isLive: async () => true, enqueue: async message => { messages.push(message); },
  };
  const journal = new BridgeJournal(path, { version: 1, adapter: adapter.kind, binding: adapter.binding,
    source: { base: source.base, subscription: source.subscription } });
  const worker = () => new SessionBridge(new BridgeJournal(path), source, adapter, ["monitor-protocol"]);
  const initialCursor = service.store.subscriptions.get(subscription.id)!.cursor;
  assert.equal(await worker().step(), "queued");
  const item = journal.pending()!;
  assert.equal(service.store.subscriptions.get(subscription.id)!.cursor, initialCursor);
  assert.ok(!messages[0].includes("untrusted-payload-only-on-show"));
  assert.ok(!messages[0].includes(token));
  assert.equal(journal.get(item.id).event.data.text, "untrusted-payload-only-on-show");
  assert.equal(await worker().step(), "waiting-for-handling", "real HTTP redelivery metadata does not change identity");
  assert.equal(service.store.subscriptions.get(subscription.id)!.cursor, initialCursor, "showing and queueing do not acknowledge");
  journal.handle(item.id, "record:attended-7");
  assert.equal(service.store.subscriptions.get(subscription.id)!.cursor, initialCursor, "receipt is durable before the HTTP acknowledgement");
  assert.equal(await worker().step(), "acknowledged");
  assert.equal(service.store.subscriptions.get(subscription.id)!.cursor, item.next);
  assert.equal(await worker().step(), "idle");
  assert.equal(messages.length, 1);
  assert.equal(new BridgeJournal(path).pending(), null);
});
