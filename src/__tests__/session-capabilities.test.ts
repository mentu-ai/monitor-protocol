import assert from "node:assert/strict";
import { test } from "node:test";
import {
  admitCapabilityWork, assertCapabilityReceipt, capabilityDigest, CodexAppServerCapabilities,
  preflightCapabilities, type CapabilityBinding, type CapabilityProfile, type CodexCapabilityRpc,
} from "../session/capabilities.js";

const tool = { name: "fixture_read", description: "Read the operator test fixture", inputSchema: {
  type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false,
}, annotations: { readOnlyHint: true } };
function fixture() {
  const expected: CapabilityBinding = {
    provider: "codex", sessionId: "owned-thread", runtimeId: "runtime-incarnation-1",
    configSha256: capabilityDigest({ model: "test-model", permissions: "read-only" }), workspace: "/fixture/workspace",
  };
  let current = structuredClone(expected);
  const profile: CapabilityProfile = { version: 1, id: "fixture-read-v1", ttlMs: 30_000, timeoutMs: 500,
    required: [{ id: "fixture.read", server: "fixture", tool: tool.name, toolSha256: capabilityDigest(tool),
      probe: { kind: "read-only", arguments: { id: "operator-pinned-fixture" }, assertions: [
        { path: "/structuredContent/identity", equals: "operator-pinned-fixture" },
        { path: "/structuredContent/readable", equals: true },
      ] } }],
  };
  const calls: { method: string; params: Record<string, unknown>; signal: AbortSignal }[] = [];
  let inventory: unknown = { data: [{ name: "fixture", runtimeStatus: "connected", toolsError: null,
    tools: { [tool.name]: tool }, authStatus: "unsupported" }], nextCursor: null };
  let result: unknown = { content: [{ type: "text", text: "fixture visible" }], structuredContent: {
    identity: "operator-pinned-fixture", readable: true,
  } };
  let hook: ((method: string) => void) | undefined;
  let rpcOverride: CodexCapabilityRpc["request"] | undefined;
  const rpc: CodexCapabilityRpc = { request: async (method, params, options) => {
    calls.push({ method, params: structuredClone(params), signal: options.signal });
    hook?.(method);
    if (rpcOverride) return rpcOverride(method, params, options);
    if (method === "mcpServerStatus/list") return structuredClone(inventory);
    assert.equal(method, "mcpServer/tool/call", "never start/resume or use an independent MCP transport");
    return structuredClone(result);
  } };
  const adapter = new CodexAppServerCapabilities(rpc, async () => structuredClone(current));
  return { expected, profile, calls, adapter,
    setBinding: (b: CapabilityBinding) => { current = b; },
    setInventory: (value: unknown) => { inventory = value; },
    setResult: (value: unknown) => { result = value; },
    setHook: (value: (method: string) => void) => { hook = value; },
    setRpc: (value: CodexCapabilityRpc["request"]) => { rpcOverride = value; },
  };
}

test("fresh session-bound inventory and real probe precede callback; receipt retains no raw result", async () => {
  const f = fixture();
  const admitted = await admitCapabilityWork(f.profile, f.expected, f.adapter, receipt => {
    assert.equal(f.calls.length, 2);
    assert.equal(receipt.status, "verified");
    return "work-result";
  });
  assert.equal(admitted.result, "work-result");
  assert.deepEqual(f.calls.map(c => [c.method, c.params.threadId]), [
    ["mcpServerStatus/list", "owned-thread"], ["mcpServer/tool/call", "owned-thread"],
  ]);
  assert.deepEqual(f.calls[1].params, { threadId: "owned-thread", server: "fixture", tool: "fixture_read",
    arguments: { id: "operator-pinned-fixture" } });
  assertCapabilityReceipt(admitted.receipt, f.profile, f.expected);
  assert.ok(!JSON.stringify(admitted.receipt).includes("fixture visible"));
  const second = await preflightCapabilities(f.profile, f.expected, f.adapter);
  assert.notEqual(second.runId, admitted.receipt.runId);
  assert.notEqual(second.nonce, admitted.receipt.nonce);
  assert.equal(f.calls.length, 4, "receipt never suppresses live preflight");
});

test("canonical digests ignore object insertion order but pin full tool contract", () => {
  assert.equal(capabilityDigest({ b: 2, a: 1 }), capabilityDigest({ a: 1, b: 2 }));
  assert.notEqual(capabilityDigest(tool), capabilityDigest({ ...tool, description: "Changed" }));
  assert.throws(() => capabilityDigest({ bad: undefined }));
});

test("cached catalogue cannot admit when live call fails or returns isError", async () => {
  for (const failure of ["reject", "isError", "semantic", "malformed"]) {
    const f = fixture(); let work = 0;
    if (failure === "reject") f.setHook(method => { if (method === "mcpServer/tool/call") throw new Error("private-token-never-log"); });
    if (failure === "isError") f.setResult({ content: [], isError: true, structuredContent: { identity: "operator-pinned-fixture", readable: true } });
    if (failure === "semantic") f.setResult({ content: [], structuredContent: { identity: "wrong-surface", readable: true } });
    if (failure === "malformed") f.setResult({ structuredContent: { identity: "operator-pinned-fixture", readable: true } });
    await assert.rejects(admitCapabilityWork(f.profile, f.expected, f.adapter, () => { work++; }), error => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes("private-token"));
      return true;
    });
    assert.equal(work, 0);
    assert.equal(f.calls.length, 2);
  }
});

test("wrong session, runtime, config, workspace, or provider is refused before inventory", async () => {
  for (const field of ["sessionId", "runtimeId", "configSha256", "workspace", "provider"] as const) {
    const f = fixture(); let work = 0;
    f.setBinding({ ...f.expected, [field]: field === "configSha256" ? capabilityDigest("changed") : "different" });
    await assert.rejects(admitCapabilityWork(f.profile, f.expected, f.adapter, () => { work++; }), { code: "BINDING_CHANGED" });
    assert.equal(f.calls.length, 0); assert.equal(work, 0);
  }
});

test("runtime change during inventory or live probe refuses admission", async () => {
  for (const stage of ["mcpServerStatus/list", "mcpServer/tool/call"]) {
    const f = fixture(); let work = 0;
    f.setHook(method => { if (method === stage) f.setBinding({ ...f.expected, runtimeId: "restarted" }); });
    await assert.rejects(admitCapabilityWork(f.profile, f.expected, f.adapter, () => { work++; }), { code: "BINDING_CHANGED" });
    assert.equal(work, 0);
    assert.equal(f.calls.length, stage === "mcpServerStatus/list" ? 1 : 2);
  }
});

test("configuration change immediately before callback refuses admission", async () => {
  const f = fixture(); let bindings = 0, work = 0;
  const adapter = { inventory: f.adapter.inventory.bind(f.adapter), probe: f.adapter.probe.bind(f.adapter),
    getBinding: async () => {
      bindings++;
      return bindings === 6 ? { ...f.expected, configSha256: capabilityDigest("drift") } : f.expected;
    },
  };
  await assert.rejects(admitCapabilityWork(f.profile, f.expected, adapter, () => { work++; }), { code: "BINDING_CHANGED" });
  assert.equal(bindings, 6); assert.equal(work, 0);
});

test("missing and schema-drifted tools fail before any probe; all required tools are checked", async () => {
  for (const kind of ["missing", "schema"]) {
    const f = fixture();
    if (kind === "schema") f.profile.required[0].toolSha256 = capabilityDigest("different-contract");
    else f.profile.required.push({ ...structuredClone(f.profile.required[0]), id: "missing", tool: "not_registered" });
    await assert.rejects(preflightCapabilities(f.profile, f.expected, f.adapter), {
      code: kind === "schema" ? "SCHEMA_MISMATCH" : "MISSING_CAPABILITY",
    });
    assert.equal(f.calls.length, 1);
  }
});

test("disconnected cached inventory is not an available capability", async () => {
  const f = fixture();
  f.setInventory({ data: [{ name: "fixture", runtimeStatus: "starting", tools: { fixture_read: tool } }] });
  await assert.rejects(preflightCapabilities(f.profile, f.expected, f.adapter), { code: "MISSING_CAPABILITY" });
  assert.equal(f.calls.length, 1);
});

test("duplicate capability ids or duplicated server/tool declarations are refused", async () => {
  for (const duplicate of ["id", "tool"]) {
    const f = fixture();
    f.profile.required.push({ ...structuredClone(f.profile.required[0]),
      ...(duplicate === "id" ? { tool: "other" } : { id: "other" }) });
    await assert.rejects(preflightCapabilities(f.profile, f.expected, f.adapter), { code: "INVALID_PROFILE" });
    assert.equal(f.calls.length, 0);
  }
});

test("operator probes require semantic assertions and read-only declaration", async () => {
  for (const kind of ["empty", "mutation", "pointer"]) {
    const f = fixture();
    if (kind === "empty") f.profile.required[0].probe.assertions = [];
    if (kind === "mutation") (f.profile.required[0].probe as { kind: string }).kind = "write";
    if (kind === "pointer") f.profile.required[0].probe.assertions[0].path = "/bad~escape";
    await assert.rejects(preflightCapabilities(f.profile, f.expected, f.adapter), { code: "INVALID_PROFILE" });
    assert.equal(f.calls.length, 0);
  }
});

test("deadline aborts a late live response and never runs callback", async () => {
  const f = fixture(); f.profile.timeoutMs = 10;
  let work = 0, resolveProbe: ((value: unknown) => void) | undefined;
  const originalInventory = { data: [{ name: "fixture", runtimeStatus: "connected", tools: { fixture_read: tool } }] };
  f.setRpc(async method => method === "mcpServerStatus/list" ? originalInventory : new Promise(resolve => { resolveProbe = resolve; }));
  await assert.rejects(admitCapabilityWork(f.profile, f.expected, f.adapter, () => { work++; }), { code: "TIMEOUT" });
  assert.ok(f.calls[1].signal.aborted);
  resolveProbe?.({ content: [], structuredContent: { identity: "operator-pinned-fixture", readable: true } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(work, 0);
});

test("binding discovery itself is bounded", async () => {
  const f = fixture(); f.profile.timeoutMs = 10;
  const adapter = { inventory: f.adapter.inventory.bind(f.adapter), probe: f.adapter.probe.bind(f.adapter),
    getBinding: async (): Promise<CapabilityBinding> => new Promise(() => {}),
  };
  await assert.rejects(preflightCapabilities(f.profile, f.expected, adapter), { code: "TIMEOUT" });
  assert.equal(f.calls.length, 0);
});

test("synchronous adapter work cannot evade the deadline before timers fire", async () => {
  const f = fixture(); f.profile.timeoutMs = 5;
  let work = 0;
  f.setHook(method => {
    if (method === "mcpServer/tool/call") {
      const until = performance.now() + 15;
      while (performance.now() < until) { /* simulate an adapter blocking the event loop */ }
    }
  });
  await assert.rejects(admitCapabilityWork(f.profile, f.expected, f.adapter, () => { work++; }), { code: "TIMEOUT" });
  assert.equal(work, 0);
});

test("adapter mutation cannot redefine the binding requested by standalone preflight", async () => {
  for (const phase of ["inventory", "probe"] as const) {
    const f = fixture();
    const original = f.adapter[phase].bind(f.adapter);
    if (phase === "inventory") f.adapter.inventory = async (binding, signal) => {
      binding.sessionId = "substituted"; f.setBinding(binding);
      return (original as typeof f.adapter.inventory)(binding, signal);
    };
    else f.adapter.probe = async (binding, capability, signal) => {
      binding.sessionId = "substituted"; f.setBinding(binding);
      return (original as typeof f.adapter.probe)(binding, capability, signal);
    };
    await assert.rejects(preflightCapabilities(f.profile, f.expected, f.adapter), { code: "BINDING_CHANGED" });
    assert.equal(f.expected.sessionId, "owned-thread");
  }
});

test("receipt rejects replay after expiry/restart/session/config/workspace/profile change and tampering", async () => {
  const f = fixture(), receipt = await preflightCapabilities(f.profile, f.expected, f.adapter);
  assert.throws(() => assertCapabilityReceipt(receipt, f.profile, f.expected, Date.parse(receipt.expiresAt)), { code: "EXPIRED_RECEIPT" });
  assert.throws(() => assertCapabilityReceipt(receipt, f.profile, f.expected, Date.parse(receipt.issuedAt) - 1), { code: "EXPIRED_RECEIPT" });
  for (const field of ["runtimeId", "sessionId", "configSha256", "workspace"] as const) {
    assert.throws(() => assertCapabilityReceipt(receipt, f.profile, { ...f.expected,
      [field]: field === "configSha256" ? capabilityDigest("changed") : "changed" }), { code: "INVALID_RECEIPT" });
  }
  assert.throws(() => assertCapabilityReceipt(receipt, { ...f.profile, id: "changed" }, f.expected), { code: "INVALID_RECEIPT" });
  const tampered = structuredClone(receipt); tampered.checks[0].resultSha256 = capabilityDigest("tampered");
  assert.throws(() => assertCapabilityReceipt(tampered, f.profile, f.expected), { code: "INVALID_RECEIPT" });
});

test("preflight expiry is not postponed by a slow successful tool", async () => {
  const f = fixture(); f.profile.ttlMs = 1;
  const original = f.adapter.probe.bind(f.adapter);
  f.adapter.probe = async (...args) => { await new Promise(resolve => setTimeout(resolve, 5)); return original(...args); };
  await assert.rejects(preflightCapabilities(f.profile, f.expected, f.adapter), { code: "EXPIRED_RECEIPT" });
});

test("pagination keeps exact thread binding and rejects repeated cursors or duplicate tools", async () => {
  const f = fixture(); let page = 0;
  f.setRpc(async (method, params) => {
    assert.equal(params.threadId, f.expected.sessionId);
    if (method === "mcpServer/tool/call") return { content: [], structuredContent: { identity: "operator-pinned-fixture", readable: true } };
    page++;
    return page === 1 ? { data: [], nextCursor: "page-2" } :
      { data: [{ name: "fixture", runtimeStatus: "connected", tools: { fixture_read: tool } }], nextCursor: null };
  });
  await preflightCapabilities(f.profile, f.expected, f.adapter);
  assert.equal(f.calls[1].params.cursor, "page-2");
  f.setRpc(async () => ({ data: [], nextCursor: "repeated" }));
  await assert.rejects(preflightCapabilities(f.profile, f.expected, f.adapter), { code: "INVALID_INVENTORY" });
});

test("mutating caller-owned profile during RPC cannot substitute probe arguments", async () => {
  const f = fixture();
  f.setHook(method => { if (method === "mcpServerStatus/list") f.profile.required[0].probe.arguments = { id: "event-selected-target" }; });
  await preflightCapabilities(f.profile, f.expected, f.adapter);
  assert.deepEqual(f.calls[1].params.arguments, { id: "operator-pinned-fixture" });
});

test("JSON pointer assertions preserve escaped keys and distinguish missing from null", async () => {
  const f = fixture();
  f.profile.required[0].probe.assertions = [{ path: "/structuredContent/a~1b/~0value", equals: null }];
  f.setResult({ content: [], structuredContent: { "a/b": { "~value": null } } });
  await preflightCapabilities(f.profile, f.expected, f.adapter);
  f.setResult({ content: [], structuredContent: { "a/b": {} } });
  await assert.rejects(preflightCapabilities(f.profile, f.expected, f.adapter), { code: "PROBE_FAILED" });
});
