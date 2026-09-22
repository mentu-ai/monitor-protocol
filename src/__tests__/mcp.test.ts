import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MonitorService } from "../server/core.js";
import { createMcpServer, MCP_TOOL_DEFINITIONS } from "../server/mcp.js";
import { MemoryStore } from "../store.js";
import type { Monitor, PullResult, State, Subscription } from "../types.js";

async function connected() {
  const service = new MonitorService(new MemoryStore());
  const { server } = createMcpServer(service);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { service, client, server };
}
const structured = <T>(r: unknown): T => (r as { structuredContent?: unknown }).structuredContent as T;

test("the advertised tool list is the static surface", async () => {
  const { client } = await connected();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), MCP_TOOL_DEFINITIONS.map(t => t.name).sort());
  assert.ok(tools.every(t => (t.description ?? "").length > 0 && t.inputSchema));
});

test("create, publish, subscribe, pull and ack over MCP tools", async () => {
  const { client } = await connected();
  const created = await client.callTool({ name: "monitor_create", arguments: { id: "ci-mcp", name: "CI", horizon: "minute", capabilities: ["observe"], visibility: "public", types: ["com.example.ci.run"] } });
  const { monitor, owner_token } = structured<{ monitor: Monitor; owner_token: string }>(created);
  assert.equal(monitor.id, "ci-mcp");

  const published = await client.callTool({ name: "monitor_publish", arguments: { id: monitor.id, bearer: owner_token, type: "com.example.ci.run", subject: "build-9", data: { status: "green" }, tier: "measured", origin: "probe" } });
  assert.notEqual(published.isError, true);

  const subscribed = await client.callTool({ name: "monitor_subscribe", arguments: { monitor: monitor.id, subscriber: "agent:claude@deadbeef", capabilities: ["observe"] } });
  const { subscription, token } = structured<{ subscription: Subscription; token: string }>(subscribed);

  const pulled = await client.callTool({ name: "monitor_pull", arguments: { subscription: subscription.id, bearer: token, limit: 10 } });
  const page = structured<PullResult>(pulled);
  assert.ok(page.observations.some(o => o.type === "com.example.ci.run"));

  const acked = await client.callTool({ name: "monitor_ack", arguments: { subscription: subscription.id, bearer: token, cursor: page.next } });
  assert.equal(structured<{ cursor: number }>(acked).cursor, page.next);
});

test("a refused call is an error result, not a thrown transport fault", async () => {
  const { client } = await connected();
  const created = await client.callTool({ name: "monitor_create", arguments: { id: "guard-mcp", name: "G", horizon: "day", capabilities: ["observe"], visibility: "public", types: ["t.x"] } });
  const { monitor, owner_token } = structured<{ monitor: Monitor; owner_token: string }>(created);
  const r = await client.callTool({ name: "monitor_publish", arguments: { id: monitor.id, bearer: owner_token, type: "t.x", tier: "src", origin: "agent" } });
  assert.equal(r.isError, true);
  assert.equal(structured<{ code: string }>(r).code, "TIER_NOT_ASSERTABLE");
});

test("the state resource is readable and names its missing inputs", async () => {
  const { client } = await connected();
  const created = await client.callTool({ name: "monitor_create", arguments: { id: "res-mcp", name: "R", horizon: "hour", capabilities: ["observe"], visibility: "public", types: ["t.x"] } });
  const { monitor } = structured<{ monitor: Monitor }>(created);
  const listed = await client.listResources();
  assert.ok(listed.resources.some(r => r.uri === `monitor://${monitor.id}/state`));
  const read = await client.readResource({ uri: `monitor://${monitor.id}/state` });
  const state = JSON.parse((read.contents[0] as { text: string }).text) as State;
  assert.equal(state.monitor, monitor.id);
  assert.equal(state.confidence.value, null);
  assert.ok(state.confidence.inputs.missing.length > 0);
});

test("a subscribed state resource is announced as updated when an observation lands", async () => {
  const { client } = await connected();
  const created = await client.callTool({ name: "monitor_create", arguments: { id: "wake-mcp", name: "W", horizon: "minute", capabilities: ["observe"], visibility: "public", types: ["t.tick"] } });
  const { monitor, owner_token } = structured<{ monitor: Monitor; owner_token: string }>(created);
  const uri = `monitor://${monitor.id}/state`;
  const updated = new Promise<string>(resolve => {
    client.fallbackNotificationHandler = async n => {
      if (n.method === "notifications/resources/updated") resolve(((n.params ?? {}) as { uri?: string }).uri ?? "");
    };
  });
  await client.subscribeResource({ uri });
  await client.callTool({ name: "monitor_publish", arguments: { id: monitor.id, bearer: owner_token, type: "t.tick", data: {}, tier: "measured", origin: "probe" } });
  const got = await Promise.race([updated, new Promise<string>((_, rej) => setTimeout(() => rej(new Error("no notification within 2s")), 2000))]);
  assert.equal(got, uri);
});
