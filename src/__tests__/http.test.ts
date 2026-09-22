import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MonitorClient } from "../client.js";
import { MonitorService } from "../server/core.js";
import { createHttpServer, listen } from "../server/http.js";
import { MemoryStore } from "../store.js";
import type { Monitor, PullResult, State } from "../types.js";
import { watch } from "../watch.js";

const ADMIN = "admin-token-for-tests";
const service = new MonitorService(new MemoryStore());
const server = createHttpServer(service, { allowAdmin: true, adminToken: ADMIN });
const bound = await listen(server, 0);
const client = new MonitorClient(bound.url);
after(() => bound.close());

test("REST: create, publish, subscribe, pull, ack, state", async () => {
  const created = await client.createMonitor({ id: "ci", name: "CI", horizon: "minute", capabilities: ["observe", "act"], visibility: "public", types: ["com.example.ci.run"] });
  assert.equal(created.status, 201);
  const { monitor, owner_token } = created.body as { monitor: Monitor; owner_token: string };

  const published = await client.publish(monitor.id, owner_token, { type: "com.example.ci.run", subject: "build-1", tier: "measured", origin: "probe", data: { status: "failed" } });
  assert.equal(published.status, 201);

  const sub = await client.subscribe({ monitor: monitor.id, subscriber: "agent:claude@abcd1234", capabilities: ["observe"] });
  assert.equal(sub.status, 201);
  const { subscription, token } = sub.body as { subscription: { id: string }; token: string };

  const page = await client.pull<PullResult>(subscription.id, token, { limit: 10 });
  assert.equal(page.status, 200);
  assert.ok(page.body.observations.some(o => o.type === "com.example.ci.run"));
  assert.equal(page.body.observations[0].specversion, "1.0");

  const acked = await client.ack<{ cursor: number }>(subscription.id, token, page.body.next);
  assert.equal(acked.body.cursor, page.body.next);

  const state = await client.state<State>(monitor.id);
  assert.equal(state.status, 200);
  assert.equal(state.body.confidence.value, null);
  assert.equal(state.body.counters.subscriptions_active, 1);
});

test("REST: an unknown filter key is refused by name", async () => {
  const r = await client.subscribe<{ code: string; known_keys: string[] }>({ monitor: "ci", subscriber: "x", filter: { typo: ["a"] } });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "INVALID_FILTER");
  assert.ok(r.body.known_keys.includes("types"));
});

test("JSON-RPC: a batch returns one result per call and maps errors", async () => {
  const r = await client.rpc<{ id: number; result?: unknown; error?: { code: number } }[]>([
    { jsonrpc: "2.0", id: 1, method: "monitors/discover", params: {} },
    { jsonrpc: "2.0", id: 2, method: "monitors/get", params: { id: "nope" } },
  ]);
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 2);
  assert.ok(r.body[0].result);
  assert.equal(r.body[1].error?.code, -32006);
});

test("SSE: the stream resumes from Last-Event-ID and frames one observation", async () => {
  const created = await client.createMonitor({ id: "sse-mon", name: "SSE", horizon: "minute", capabilities: ["observe"], visibility: "public", types: ["com.example.tick"] });
  const { monitor, owner_token } = created.body as { monitor: Monitor; owner_token: string };
  const sub = await client.subscribe({ monitor: monitor.id, subscriber: "agent:sse", capabilities: ["observe"] });
  const { subscription, token } = sub.body as { subscription: { id: string }; token: string };

  const ac = new AbortController();
  const res = await fetch(`${bound.url}/mp/v0/subscriptions/${subscription.id}/stream`, {
    headers: { Authorization: `Bearer ${token}`, "Last-Event-ID": "0" }, signal: ac.signal,
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  await client.publish(monitor.id, owner_token, { type: "com.example.tick", subject: "t1", data: { n: 1 } });
  let buf = "";
  const deadline = Date.now() + 8000;
  while (!/"type":"com\.example\.tick"/.test(buf) && Date.now() < deadline) {   // the declared type list appears in earlier frames
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
  }
  ac.abort();
  assert.match(buf, /retry: 3000/);
  assert.match(buf, /event: observation/);
  assert.match(buf, /^id: \d+$/m);
  assert.match(buf, /"type":"com\.example\.tick"/);
});

test("watch prints one line per observation and acks after printing", async () => {
  const created = await client.createMonitor({ id: "watched", name: "W", horizon: "minute", capabilities: ["observe"], visibility: "public", types: ["com.example.w"] });
  const { monitor, owner_token } = created.body as { monitor: Monitor; owner_token: string };
  const sub = await client.subscribe({ monitor: monitor.id, subscriber: "agent:watcher", capabilities: ["observe"] });
  const { subscription, token } = sub.body as { subscription: { id: string }; token: string };
  await client.publish(monitor.id, owner_token, { type: "com.example.w", subject: "one", tier: "measured", origin: "probe", data: { a: 1 } });

  const lines: string[] = [];
  await watch({ base: bound.url, subscription: subscription.id, token, once: true, wait: 0, out: l => lines.push(l) });
  const obs = lines.filter(l => l.startsWith("OBS "));
  assert.ok(obs.length >= 1, lines.join("\n"));
  assert.match(obs.at(-1)!, /type=com\.example\.w subject=one tier=measured/);

  const after = await client.pull<PullResult>(subscription.id, token, { wait: 0 });
  assert.equal(after.body.observations.length, 0, "watch should have acked what it printed");
});

test("the admin endpoints are closed by default and authenticated when open", async () => {
  const closed = new MonitorService(new MemoryStore());
  const b2 = await listen(createHttpServer(closed), 0);
  try {
    assert.equal((await fetch(`${b2.url}/mp/v0/admin/compact`, { method: "POST", body: "{}" })).status, 404);
    assert.equal((await fetch(`${b2.url}/mp/v0/admin/snapshot`)).status, 404);
  } finally { await b2.close(); }

  assert.equal((await fetch(`${bound.url}/mp/v0/admin/snapshot`)).status, 401, "the snapshot exports token hashes; it must not be anonymous");
  const wrong = await fetch(`${bound.url}/mp/v0/admin/compact`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer nope" }, body: JSON.stringify({ upto_seq: 0 }) });
  assert.equal(wrong.status, 401);
  const right = await fetch(`${bound.url}/mp/v0/admin/compact`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN}` }, body: JSON.stringify({ upto_seq: 0 }) });
  assert.equal(right.status, 200);
});
