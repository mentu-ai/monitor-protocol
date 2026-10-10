/**
 * Claude Code tool probes, observed in the session's own transcript.
 *
 * Claude Code does not expose each tool's full advertised schema to the session, so the
 * schema pin of a capability receipt cannot be checked and strict admission stays refused
 * (docs/shared-harness-contract.md). What can be shown is narrower: after a request that
 * carries a fresh nonce, the bound session itself called the pinned MCP tool with the
 * profile's probe arguments, the host recorded a non-error result, and the operator's
 * assertions hold on it. That is an observation, never a receipt: its kind differs, so
 * assertCapabilityReceipt and admission refuse it.
 *
 * The transcript path comes from a hook payload's `transcript_path`. Its line format is
 * not a documented interface, and any process running as the same user can write it:
 * this is host evidence, not authentication.
 */
import { readFile } from "node:fs/promises";
import { capabilityDigest, capabilityResultMatches, type RequiredCapability } from "./capabilities.js";
import type { ClaudeBinding } from "./claude.js";

export interface ClaudeProbeObservation {
  version: 1;
  kind: "claude-tool-probe-observation";
  status: "observed";
  session: string;
  capability: string;
  server: string;
  tool: string;
  nonce: string;
  toolUseId: string;
  requestedAt: string;
  calledAt: string;
  resultAt: string;
  resultSha256: string;
}

export class ClaudeProbeError extends Error {
  constructor(public readonly code: "INVALID_REQUEST" | "INVALID_TRANSCRIPT" | "NOT_OBSERVED" | "PROBE_FAILED", message: string) {
    super(message);
    this.name = "ClaudeProbeError";
  }
}

type Entry = Record<string, unknown>;
const record = (v: unknown): v is Entry => !!v && typeof v === "object" && !Array.isArray(v);
const when = (entry: Entry): number => typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
const blocks = (entry: Entry): unknown[] => {
  const message = entry.message;
  if (!record(message)) return [];
  return typeof message.content === "string" ? [{ type: "text", text: message.content }] :
    Array.isArray(message.content) ? message.content : [];
};
const userText = (entry: Entry): string => blocks(entry)
  .map(b => record(b) && b.type === "text" && typeof b.text === "string" ? b.text : "").join("\n");

/** Map a Claude tool_result to the MCP CallToolResult shape that profile assertions address. */
function mcpResult(block: Entry): { content: unknown[]; isError: false } {
  const content = typeof block.content === "string" ? [{ type: "text", text: block.content }] :
    Array.isArray(block.content) ? block.content : [];
  return { content, isError: false };
}

/** The pinned probe, called by the bound session after the nonce, with a non-error result. */
export async function observeClaudeProbe(
  binding: ClaudeBinding, capability: RequiredCapability, nonce: string, since: string, transcript: string,
  read: (path: string) => Promise<string> = path => readFile(path, "utf8"),
): Promise<ClaudeProbeObservation> {
  const start = Date.parse(since);
  if (binding?.provider !== "claude" || !/^[a-f0-9]{32,128}$/.test(nonce) || !Number.isFinite(start)) {
    throw new ClaudeProbeError("INVALID_REQUEST", "A Claude binding, a hex nonce of 32 to 128 digits and a start time are required");
  }
  let lines: string[];
  try { lines = (await read(transcript)).split("\n").filter(Boolean); }
  catch { throw new ClaudeProbeError("INVALID_TRANSCRIPT", "The session transcript could not be read"); }
  const entries: Entry[] = [];
  for (const line of lines) {
    try { const e: unknown = JSON.parse(line); if (record(e)) entries.push(e); }
    catch { throw new ClaudeProbeError("INVALID_TRANSCRIPT", "The session transcript has a malformed line"); }
  }
  // Only this session's own entries, from the start time on, count.
  const mine = entries.filter(e => e.sessionId === binding.session && when(e) >= start && e.isSidechain !== true);
  const requestAt = mine.findIndex(e => e.type === "user" && userText(e).includes(nonce));
  if (requestAt < 0) throw new ClaudeProbeError("NOT_OBSERVED", "No request with this nonce in the bound session");
  const name = `mcp__${capability.server}__${capability.tool}`;
  const wanted = capabilityDigest(capability.probe.arguments);
  for (let i = requestAt + 1; i < mine.length; i++) {
    if (mine[i].type !== "assistant") continue;
    for (const use of blocks(mine[i])) {
      if (!record(use) || use.type !== "tool_use" || use.name !== name || typeof use.id !== "string") continue;
      let same = false;
      try { same = capabilityDigest(use.input) === wanted; } catch { /* not JSON data */ }
      if (!same) continue;
      for (let j = i + 1; j < mine.length; j++) {
        if (mine[j].type !== "user") continue;
        const result = blocks(mine[j]).find(b => record(b) && b.type === "tool_result" && b.tool_use_id === use.id);
        if (!record(result)) continue;
        if (result.is_error !== undefined && result.is_error !== false) {
          throw new ClaudeProbeError("PROBE_FAILED", `The probe returned an error: ${capability.id}`);
        }
        const mapped = mcpResult(result);
        if (!capabilityResultMatches(mapped, capability)) {
          throw new ClaudeProbeError("PROBE_FAILED", `Probe semantic assertion failed: ${capability.id}`);
        }
        return {
          version: 1, kind: "claude-tool-probe-observation", status: "observed",
          session: binding.session, capability: capability.id, server: capability.server, tool: capability.tool,
          nonce, toolUseId: use.id,
          requestedAt: new Date(when(mine[requestAt])).toISOString(),
          calledAt: new Date(when(mine[i])).toISOString(),
          resultAt: new Date(when(mine[j])).toISOString(),
          resultSha256: capabilityDigest(mapped),
        };
      }
      throw new ClaudeProbeError("NOT_OBSERVED", `The probe call has no recorded result: ${capability.id}`);
    }
  }
  throw new ClaudeProbeError("NOT_OBSERVED", `The bound session did not call the pinned probe after the nonce: ${capability.id}`);
}
