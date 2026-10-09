import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { MonitorService } from "../server/core.js";
import { createHttpServer, listen } from "../server/http.js";
import { BridgeRetryError, HttpSubscriptionSource } from "../session/source.js";
import { MemoryStore } from "../store.js";
import type { Observation, Subscription } from "../types.js";

const TOKEN = "source-test-private-bearer";
function observation(): Observation {
  return {
    specversion: "1.0", source: "monitor:example", id: "event-4", sequence: "00000000000000000004",
    type: "com.example.changed", time: "2026-10-09T00:00:00Z", tier: "measured", origin: "probe",
    verified: "machine_verified", horizon: "event", actor: "probe:example",
    data: { provenance: { tier: "measured", origin: "probe", verification: "machine_verified", actor: "probe:example" } },
  };
}
function page(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { subscription: "sub-test", monitor: "example", cursor: 3, next: 5, head: 4,
    retention_floor: 1, observations: [observation()], ...overrides };
}
function source(value: unknown = page(), status = 200): HttpSubscriptionSource {
  return new HttpSubscriptionSource("https://example.test", "sub-test", TOKEN, {
    fetch: async () => new Response(JSON.stringify(value), { status }),
  });
}
const permanent = (e: unknown): boolean => e instanceof Error && !(e instanceof BridgeRetryError);

test("session source accepts canonical HTTPS/loopback roots and refuses unsafe bases", () => {
  for (const [given, expected] of [
    ["https://EXAMPLE.test/mp/v0/", "https://example.test"],
    ["http://127.0.0.1:9000/", "http://127.0.0.1:9000"],
    ["http://localhost:9000/mp/v0", "http://localhost:9000"],
    ["http://[::1]:9000", "http://[::1]:9000"],
  ]) assert.equal(new HttpSubscriptionSource(given, "sub-test", TOKEN).base, expected);
  for (const base of ["/relative", "http://example.test", "ftp://localhost", "https://user:secret@example.test",
    "https://example.test?", "https://example.test#", "https://example.test/?token=secret", "https://example.test/other",
    "http://localhost.example.test", "file:///tmp/protocol"]) {
    assert.throws(() => new HttpSubscriptionSource(base, "sub-test", TOKEN), permanent, base);
  }
  for (const id of ["", ".", "..", "sub\nother"]) assert.throws(() => new HttpSubscriptionSource("https://example.test", id, TOKEN));
  assert.throws(() => new HttpSubscriptionSource("https://example.test", "sub-test", ""));
  assert.throws(() => new HttpSubscriptionSource("https://example.test", "sub-test", "x\r\nInjected: true"));
});

test("session source encodes the subscription and only calls pull/ack with bounded nonredirecting requests", async () => {
  const sid = "sub/one?two#three";
  const calls: { url: string; options: RequestInit }[] = [];
  const s = new HttpSubscriptionSource("https://example.test/mp/v0", sid, TOKEN, { fetch: async (input, init) => {
    const url = String(input), options = init!;
    calls.push({ url, options });
    return Response.json(options.method === "POST" ? { subscription: sid, cursor: 5 } : page({ subscription: sid }));
  } });
  assert.equal((await s.pull())!.next, 5);
  assert.equal(calls.length, 1, "pull alone must not acknowledge");
  await s.acknowledge(5);
  assert.deepEqual(calls.map(c => c.url), [
    "https://example.test/mp/v0/subscriptions/sub%2Fone%3Ftwo%23three/pull?wait=0&limit=1",
    "https://example.test/mp/v0/subscriptions/sub%2Fone%3Ftwo%23three/ack",
  ]);
  for (const { options } of calls) {
    assert.equal(options.redirect, "manual");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(new Headers(options.headers).get("authorization"), `Bearer ${TOKEN}`);
  }
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[1].options.body, JSON.stringify({ cursor: 5 }));
});

test("session source uses the reference HTTP subscription without consuming until explicit ack", async t => {
  const service = new MonitorService(new MemoryStore());
  const created = service.createMonitor({ id: "bridge", name: "Bridge", horizon: "event", visibility: "public",
    capabilities: ["observe"], types: ["com.example.changed"] });
  const { owner_token } = created.body as { owner_token: string };
  const subscribed = service.subscribe({ monitor: "bridge", subscriber: "agent:test", capabilities: ["observe"],
    filter: { types: ["com.example.changed"] } }, {});
  const { subscription, token } = subscribed.body as { subscription: Subscription; token: string };
  service.monitorAction("bridge", "observations", { type: "com.example.changed", data: { ref: "record:7" } }, { bearer: owner_token });
  const bound = await listen(createHttpServer(service), 0);
  t.after(() => bound.close());
  const s = new HttpSubscriptionSource(`${bound.url}/mp/v0`, subscription.id, token);
  const before = service.store.subscriptions.get(subscription.id)!.cursor;
  const first = await s.pull(), duplicate = await s.pull();
  assert.ok(first);
  assert.deepEqual(duplicate, first, "redelivery metadata must not change the event fingerprint");
  assert.equal(first.event.redelivered, undefined);
  assert.equal(service.store.subscriptions.get(subscription.id)!.cursor, before);
  await s.acknowledge(first.next);
  await s.acknowledge(first.next);
  assert.equal(await s.pull(), null);
  assert.equal(service.store.subscriptions.get(subscription.id)!.cursor, first.next);
  service.subAction(subscription.id, "retire", {}, { bearer: token });
  await assert.rejects(s.pull(), permanent, "retirement must not trigger recreation");
});

test("session source detects a real retention gap even when the reference server returns HTTP 200", async t => {
  const service = new MonitorService(new MemoryStore());
  service.createMonitor({ id: "retained", name: "Retained", horizon: "event", visibility: "public", capabilities: ["observe"] });
  const r = service.subscribe({ monitor: "retained", subscriber: "agent:test", capabilities: ["observe"] }, {});
  const { subscription, token } = r.body as { subscription: Subscription; token: string };
  service.store.compact(service.store.head());
  const bound = await listen(createHttpServer(service), 0);
  t.after(() => bound.close());
  const s = new HttpSubscriptionSource(bound.url, subscription.id, token);
  await assert.rejects(s.pull(), /retention floor/);
  assert.equal(service.store.subscriptions.get(subscription.id)!.cursor, 0);
});

test("session source refuses wrong subscriptions, malformed envelopes, unsafe and inconsistent cursors", async () => {
  const invalid: unknown[] = [null, [], "text", page({ subscription: "sub-other" }), page({ observations: null }),
    page({ observations: [observation(), observation()] }), page({ observations: [null] }),
    page({ cursor: "3" }), page({ next: true }), page({ next: 6 }), page({ head: 3 }), page({ cursor: 5 }),
    page({ retention_floor: 4 }), page({ retention_floor: "1" }), page({ cursor: -1 }),
    page({ observations: [{ ...observation(), source: "" }] }), page({ observations: [{ ...observation(), id: 4 }] }),
    page({ observations: [{ ...observation(), sequence: "4" }] }),
    page({ observations: [{ ...observation(), sequence: "000000000000000000٠٤" }] }),
    page({ observations: [{ ...observation(), sequence: "00009007199254740991" }], next: Number.MAX_SAFE_INTEGER + 1, head: Number.MAX_SAFE_INTEGER }),
    page({ observations: [{ ...observation(), data: { untrusted: true } }] }),
  ];
  for (const value of invalid) await assert.rejects(source(value).pull(), permanent, JSON.stringify(value));
  assert.equal(await source(page({ observations: [] })).pull(), null);
});

test("session source requires the exact acknowledgement cursor and subscription", async () => {
  for (const reply of [{ subscription: "sub-test", cursor: 4 }, { subscription: "sub-test", cursor: "5" },
    { subscription: "sub-other", cursor: 5 }, { cursor: 5 }]) await assert.rejects(source(reply).acknowledge(5), permanent);
  for (const invalid of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(source().acknowledge(invalid), permanent);
});

test("session source classifies temporary HTTP failures separately from auth, retirement, retention and redirects", async () => {
  for (const status of [408, 429, 500, 503]) await assert.rejects(source({}, status).pull(), BridgeRetryError);
  for (const status of [301, 302, 307, 308, 400, 401, 403, 404, 409, 410, 413])
    await assert.rejects(source({}, status).pull(), permanent);
  const s = new HttpSubscriptionSource("https://example.test", "sub-test", TOKEN, { fetch: async () => { throw new Error(TOKEN); } });
  await assert.rejects(s.pull(), e => e instanceof BridgeRetryError && !e.message.includes(TOKEN));
});

test("session source never forwards a bearer through a real HTTP redirect", async t => {
  let receiverCalls = 0;
  const receiver = await listen(createServer((_req, res) => { receiverCalls++; res.end("{}"); }), 0);
  t.after(() => receiver.close());
  const redirector = await listen(createServer((_req, res) => { res.writeHead(307, { Location: `${receiver.url}/stolen` }); res.end(); }), 0);
  t.after(() => redirector.close());
  const s = new HttpSubscriptionSource(redirector.url, "sub-test", TOKEN);
  await assert.rejects(s.pull(), /redirects are refused/);
  assert.equal(receiverCalls, 0);
});

test("session source rejects oversized declared and streaming bodies without parsing or echoing them", async () => {
  for (const headers of [new Headers({ "content-length": "2000001" }), new Headers()]) {
    const s = new HttpSubscriptionSource("https://example.test", "sub-test", TOKEN, {
      fetch: async () => new Response("x".repeat(2_000_001), { headers }),
    });
    await assert.rejects(s.pull(), /exceeds limit/);
  }
  for (const body of ["not JSON", new Uint8Array([0xff, 0xfe])]) {
    const s = new HttpSubscriptionSource("https://example.test", "sub-test", TOKEN, { fetch: async () => new Response(body) });
    await assert.rejects(s.pull(), /valid UTF-8 JSON/);
  }
});

test("session source treats an interrupted body as retryable", async () => {
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error(TOKEN)); } });
  const s = new HttpSubscriptionSource("https://example.test", "sub-test", TOKEN, { fetch: async () => new Response(body) });
  await assert.rejects(s.pull(), e => e instanceof BridgeRetryError && !e.message.includes(TOKEN));
});

test("session source times out a real response body within five seconds", async t => {
  const server = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.write("{"); });
  const bound = await listen(server, 0);
  t.after(() => { server.closeAllConnections(); return bound.close(); });
  const s = new HttpSubscriptionSource(bound.url, "sub-test", TOKEN);
  const started = Date.now();
  await assert.rejects(s.pull(), BridgeRetryError);
  assert.ok(Date.now() - started < 7_000, "request and streaming body share the same five-second deadline");
});
