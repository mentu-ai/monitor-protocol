import assert from "node:assert/strict";
import { test } from "node:test";
import {
  capabilityDigest, type CapabilityAdapter, type CapabilityBinding, type RequiredCapability,
} from "../session/capabilities.js";
import {
  admitWorkspaceCapabilityWork, resolveWorkspaceCapabilityProfile,
  WorkspaceCapabilityAdmissionError, type WorkspaceCapabilityProfile,
} from "../session/workspace-capabilities.js";

function fixture(provider = "codex") {
  const ids = ["work.read", "context.read"];
  const tools = (name: string) => ids.map(id => ({ name: `${name}_${id.replace(".", "_")}`,
    inputSchema: { type: "object", properties: {} } }));
  const expansion = (name: string): RequiredCapability[] => tools(name).map((tool, i) => ({
    id: ids[i], server: `${name}-mcp`, tool: tool.name, toolSha256: capabilityDigest(tool),
    probe: { kind: "read-only", arguments: { identity: ids[i] },
      assertions: [{ path: "/structuredContent/identity", equals: ids[i] }] },
  }));
  const profile: WorkspaceCapabilityProfile = { version: 1, id: "shared-desk", ttlMs: 30_000,
    timeoutMs: 1000, required: ids, providers: { codex: expansion("codex"), claude: expansion("claude") } };
  const binding: CapabilityBinding = { provider, sessionId: `${provider}-session`, runtimeId: "incarnation-1",
    configSha256: capabilityDigest({ effective: "fixture" }), workspace: "shared-desk" };
  const calls: string[] = [];
  const adapter: CapabilityAdapter = {
    getBinding: async () => structuredClone(binding),
    inventory: async b => {
      assert.deepEqual(b, binding); calls.push("inventory");
      return tools(provider).map(tool => ({ server: `${provider}-mcp`, tool }));
    },
    probe: async (b, capability) => {
      assert.deepEqual(b, binding); calls.push(capability.id);
      assert.equal(capability.server, `${provider}-mcp`);
      return { content: [], structuredContent: { identity: capability.probe.arguments.identity } };
    },
  };
  return { ids, profile, binding, adapter, calls };
}

test("two providers resolve identical semantic requirements into their own pinned tools", () => {
  const f = fixture();
  // Mapping order cannot change the order of the shared requirements.
  f.profile.providers.claude.reverse();
  for (const provider of ["codex", "claude"]) {
    const resolved = resolveWorkspaceCapabilityProfile(f.profile, { ...f.binding, provider });
    assert.equal(resolved.id, f.profile.id);
    assert.deepEqual(resolved.required.map(c => c.id), f.ids);
    assert.ok(resolved.required.every(c => c.server === `${provider}-mcp` && c.tool.startsWith(provider)));
  }
});

test("each provider makes fresh real adapter probes before every work callback", async () => {
  for (const provider of ["codex", "claude"]) {
    const f = fixture(provider); let work = 0;
    const invoke = () => admitWorkspaceCapabilityWork(f.profile, f.binding, f.adapter, receipt => {
      work++; assert.equal(f.calls.length, work * 3);
      assert.equal(receipt.binding.provider, provider);
      assert.deepEqual(receipt.checks.map(check => check.capability), f.ids);
      return "done";
    });
    const first = await invoke(), second = await invoke();
    assert.equal(first.result, "done"); assert.equal(second.result, "done");
    assert.equal(work, 2); assert.notEqual(first.receipt.runId, second.receipt.runId);
    assert.deepEqual(f.calls, ["inventory", ...f.ids, "inventory", ...f.ids]);
  }
});

test("unknown, differently cased, or inherited provider name has no fallback", async () => {
  for (const provider of ["unknown", "Codex", "toString"]) {
    const f = fixture(provider); let work = 0;
    await assert.rejects(admitWorkspaceCapabilityWork(f.profile, f.binding, f.adapter, () => { work++; }),
      { code: "UNAVAILABLE_PROVIDER" });
    assert.equal(work, 0); assert.equal(f.calls.length, 0);
  }
});

test("an absent or incomplete adapter refuses work without claiming provider support", async () => {
  for (const adapter of [undefined, null, {} as CapabilityAdapter]) {
    const f = fixture(); let work = 0;
    await assert.rejects(admitWorkspaceCapabilityWork(f.profile, f.binding, adapter, () => { work++; }),
      { code: "ADAPTER_UNAVAILABLE" });
    assert.equal(work, 0);
  }
});

test("missing, extra, and duplicate semantic IDs refuse before any adapter call", async () => {
  const cases: [string, (p: WorkspaceCapabilityProfile) => void][] = [
    ["MISSING_CAPABILITY", p => { p.providers.codex.pop(); }],
    ["MISSING_CAPABILITY", p => { p.providers.claude.pop(); }],
    ["UNEXPECTED_CAPABILITY", p => { p.providers.codex.push({ ...p.providers.codex[0], id: "undeclared" }); }],
    ["DUPLICATE_CAPABILITY", p => { p.required.push(p.required[0]); }],
    ["DUPLICATE_CAPABILITY", p => { p.providers.codex.push(structuredClone(p.providers.codex[0])); }],
  ];
  for (const [code, mutate] of cases) {
    const f = fixture(); mutate(f.profile); let work = 0;
    await assert.rejects(admitWorkspaceCapabilityWork(f.profile, f.binding, f.adapter, () => { work++; }), error => {
      assert.ok(error instanceof WorkspaceCapabilityAdmissionError); assert.equal(error.code, code); return true;
    });
    assert.equal(work, 0); assert.equal(f.calls.length, 0);
  }
});

test("resolved configuration is detached from caller mutation", () => {
  const f = fixture(), resolved = resolveWorkspaceCapabilityProfile(f.profile, f.binding);
  f.profile.required[0] = "changed";
  f.profile.providers.codex[0].probe.arguments.identity = "changed";
  assert.equal(resolved.required[0].id, "work.read");
  assert.equal(resolved.required[0].probe.arguments.identity, "work.read");
});

test("invalid concrete pins and live probe failure still refuse through existing admission", async () => {
  for (const failure of ["pin", "probe", "binding"]) {
    const f = fixture(); let work = 0;
    if (failure === "pin") f.profile.providers.codex[0].toolSha256 = capabilityDigest("changed-tool");
    if (failure === "probe") f.adapter.probe = async () => ({ content: [], isError: true });
    if (failure === "binding") f.adapter.getBinding = async () => ({ ...f.binding, provider: "claude" });
    await assert.rejects(admitWorkspaceCapabilityWork(f.profile, f.binding, f.adapter, () => { work++; }),
      { code: failure === "pin" ? "SCHEMA_MISMATCH" : failure === "probe" ? "PROBE_FAILED" : "BINDING_CHANGED" });
    assert.equal(work, 0);
  }
});

test("invalid or non-JSON shared policies fail closed", () => {
  for (const mutate of [
    (p: WorkspaceCapabilityProfile) => { p.required = []; },
    (p: WorkspaceCapabilityProfile) => { p.timeoutMs = 0; },
    (p: WorkspaceCapabilityProfile) => { p.providers = {}; },
    (p: WorkspaceCapabilityProfile) => { p.providers.codex[0].probe.arguments.bad = Number.NaN; },
  ]) {
    const f = fixture(); mutate(f.profile);
    assert.throws(() => resolveWorkspaceCapabilityProfile(f.profile, f.binding), { code: "INVALID_WORKSPACE_PROFILE" });
  }
});
