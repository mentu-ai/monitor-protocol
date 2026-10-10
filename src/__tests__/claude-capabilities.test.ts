import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCapabilityReceipt, capabilityDigest, type CapabilityBinding, type CapabilityProfile,
  type CapabilityReceipt, type RequiredCapability } from "../session/capabilities.js";
import { observeClaudeProbe } from "../session/claude-capabilities.js";
import type { ClaudeBinding } from "../session/claude.js";
import { admitWorkspaceCapabilityWork, type WorkspaceCapabilityProfile } from "../session/workspace-capabilities.js";

const session = "8b8122f3-384d-428b-9194-0abc8186bf04";
const nonce = "a1".repeat(16);
const since = "2026-10-10T04:00:00.000Z";
const binding: ClaudeBinding = { provider: "claude", version: 1, platform: "darwin", session,
  process: { pid: 100, parent: 90, started: "Fri Oct 9 21:24:36 2026", tty: "ttys001", command: "claude" },
  executable: "/Users/fixture/.local/share/claude/versions/2.1.296" };
const capability: RequiredCapability = { id: "desk.read", server: "desk", tool: "status",
  toolSha256: `sha256:${"b".repeat(64)}`, probe: { kind: "read-only", arguments: { scope: "fixture" },
    assertions: [{ path: "/content/0/text", equals: "desk readable" }] } };

type Entry = Record<string, unknown>;
const at = (s: number) => new Date(Date.parse(since) + s * 1000).toISOString();
function transcript(change: (entries: Entry[]) => void = () => {}): string {
  const entries: Entry[] = [
    { type: "mode", mode: "default", sessionId: session },
    { type: "user", sessionId: session, timestamp: at(1), message: { role: "user", content: `Probe the desk; nonce ${nonce}` } },
    { type: "assistant", sessionId: session, timestamp: at(2), message: { role: "assistant", content: [
      { type: "text", text: "Calling the probe." },
      { type: "tool_use", id: "toolu_fixture_1", name: "mcp__desk__status", input: { scope: "fixture" } }] } },
    { type: "user", sessionId: session, timestamp: at(3), message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_fixture_1", is_error: false, content: [{ type: "text", text: "desk readable" }] }] } },
  ];
  change(entries);
  return entries.map(e => JSON.stringify(e)).join("\n") + "\n";
}
const observe = (text: string, n = nonce, s = since) => observeClaudeProbe(binding, capability, n, s, "/fixture/transcript.jsonl", async () => text);

test("a probe the bound session called after the nonce, with a passing result, is observed", async () => {
  const o = await observe(transcript());
  assert.deepEqual(o, { version: 1, kind: "claude-tool-probe-observation", status: "observed", session,
    capability: "desk.read", server: "desk", tool: "status", nonce, toolUseId: "toolu_fixture_1",
    requestedAt: at(1), calledAt: at(2), resultAt: at(3),
    resultSha256: capabilityDigest({ content: [{ type: "text", text: "desk readable" }], isError: false }) });
});

test("an observation is never a capability receipt, and Claude admission stays refused", async () => {
  const o = await observe(transcript());
  const profile: CapabilityProfile = { version: 1, id: "desk-v1", ttlMs: 30_000, timeoutMs: 500, required: [capability] };
  const capabilityBinding: CapabilityBinding = { provider: "claude", sessionId: session, runtimeId: "runtime-1",
    configSha256: capabilityDigest({ fixture: true }), workspace: "/fixture" };
  assert.throws(() => assertCapabilityReceipt(o as unknown as CapabilityReceipt, profile, capabilityBinding),
    { code: "INVALID_RECEIPT" });
  const workspace: WorkspaceCapabilityProfile = { version: 1, id: "desk-v1", ttlMs: 30_000, timeoutMs: 500,
    required: ["desk.read"], providers: { claude: [capability] } };
  let ran = false;
  await assert.rejects(admitWorkspaceCapabilityWork(workspace, capabilityBinding, null, () => { ran = true; }),
    { code: "ADAPTER_UNAVAILABLE" });
  assert.equal(ran, false);
});

test("nothing outside the bound session's own request, call and result is observed", async () => {
  for (const change of [
    (e: Entry[]) => { e[1].message = { role: "user", content: "Probe the desk" }; },            // no nonce
    (e: Entry[]) => { e.splice(1, 1); e.push({ ...e[0], type: "user", timestamp: at(4),
      message: { role: "user", content: `nonce ${nonce}` } }); },                                // call before the request
    (e: Entry[]) => { for (const x of e) x.sessionId = "11111111-2222-4333-8444-555555555555"; }, // another session
    (e: Entry[]) => { e[1].timestamp = "2026-10-10T03:59:59.000Z"; },                             // request before start
    (e: Entry[]) => { ((e[2].message as Entry).content as Entry[])[1].input = { scope: "other" }; }, // other arguments
    (e: Entry[]) => { ((e[2].message as Entry).content as Entry[])[1].name = "mcp__desk__write"; },  // other tool
    (e: Entry[]) => { e.pop(); },                                                                 // no recorded result
    (e: Entry[]) => { for (const x of e.slice(1)) x.isSidechain = true; },                        // a subagent's turns
  ]) {
    await assert.rejects(observe(transcript(change)), { code: "NOT_OBSERVED" });
  }
});

test("an error result or a failed assertion is a failed probe", async () => {
  await assert.rejects(observe(transcript(e => {
    (((e[3].message as Entry).content as Entry[])[0]).is_error = true;
  })), { code: "PROBE_FAILED" });
  await assert.rejects(observe(transcript(e => {
    (((e[3].message as Entry).content as Entry[])[0]).content = "desk closed";
  })), { code: "PROBE_FAILED" });
});

test("a string tool result maps to MCP text content", async () => {
  const o = await observe(transcript(e => { (((e[3].message as Entry).content as Entry[])[0]).content = "desk readable"; }));
  assert.equal(o.status, "observed");
});

test("malformed requests and transcripts are refused", async () => {
  await assert.rejects(observe(transcript(), "short"), { code: "INVALID_REQUEST" });
  await assert.rejects(observe(transcript(), nonce, "not a time"), { code: "INVALID_REQUEST" });
  await assert.rejects(observe("{not json}\n"), { code: "INVALID_TRANSCRIPT" });
  await assert.rejects(observeClaudeProbe(binding, capability, nonce, since, "/missing", async () => { throw new Error("ENOENT"); }),
    { code: "INVALID_TRANSCRIPT" });
});
