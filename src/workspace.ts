/** Read-only status projection for a shared workspace and its Construct views. */
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { BridgeJournal } from "./session/bridge.js";

export interface WorkspaceConfig {
  version: 1;
  workspace: string;
  construct: { id: string; url: string };
  sourceHealthFile: string;
  staleAfterMs: number;
  participants: Array<{ actor: string; mode: "attended-session" | "bounded-routine";
    bridgeState?: string }>;
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === "string" && !!v.trim();
const time = (v: unknown): number => typeof v === "string" ? Date.parse(v) : NaN;
const fresh = (v: unknown, now: number, ttl: number) => Number.isFinite(time(v)) && now >= time(v) && now - time(v) <= ttl;

export function validateWorkspaceConfig(input: unknown): asserts input is WorkspaceConfig {
  if (!object(input) || input.version !== 1 || !nonempty(input.workspace) || !object(input.construct) ||
      !nonempty(input.construct.id) || !nonempty(input.construct.url) ||
      !nonempty(input.sourceHealthFile) || !isAbsolute(input.sourceHealthFile) ||
      !Number.isSafeInteger(input.staleAfterMs) || Number(input.staleAfterMs) < 1000 || Number(input.staleAfterMs) > 300_000 ||
      !Array.isArray(input.participants) || input.participants.length < 1 || input.participants.length > 100)
    throw new Error("invalid workspace status configuration");
  const url = new URL(input.construct.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search)
    throw new Error("construct link must be HTTP(S) without credentials, query, or fragment");
  const seen = new Set<string>();
  for (const p of input.participants) {
    if (!object(p) || !nonempty(p.actor) || seen.has(p.actor) ||
        !["attended-session", "bounded-routine"].includes(String(p.mode)) ||
        (p.bridgeState !== undefined && (!nonempty(p.bridgeState) || !isAbsolute(p.bridgeState))))
      throw new Error("invalid or duplicate workspace participant");
    seen.add(p.actor);
  }
}

function sourceStatus(path: string, now: number, ttl: number) {
  const unavailable = { state: "unknown", ready: false, checkedAt: null, lastSuccess: null,
    workerHeartbeatAt: null, fresh: false, failureCount: null };
  try {
    // Never copy arbitrary source data, error messages, paths, tokens, or PID metadata into a view.
    const s: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!object(s) || s.version !== 1 || !["starting", "healthy", "retrying", "failed", "stopped"].includes(String(s.status)) ||
        typeof s.terminal !== "boolean" || !Number.isSafeInteger(s.failure_count) || Number(s.failure_count) < 0)
      return unavailable;
    const current = fresh(s.worker_heartbeat_at, now, ttl) && fresh(s.last_success, now, ttl);
    return { state: String(s.status), ready: s.status === "healthy" && !s.terminal && current,
      checkedAt: Number.isFinite(time(s.checked_at)) ? s.checked_at as string : null,
      lastSuccess: Number.isFinite(time(s.last_success)) ? s.last_success as string : null,
      workerHeartbeatAt: Number.isFinite(time(s.worker_heartbeat_at)) ? s.worker_heartbeat_at as string : null,
      fresh: current, failureCount: s.failure_count as number };
  } catch { return unavailable; }
}

export async function workspaceStatus(input: unknown, now = Date.now()) {
  validateWorkspaceConfig(input);
  const participants = await Promise.all(input.participants.map(async p => {
    const base = { actor: p.actor, mode: p.mode, transport: "unconfigured", worker: "unknown",
      delivery: null as string | null, phase: "unknown", capabilityReadiness: "unverified",
      nativeWake: "unverified" };
    if (!p.bridgeState) return base;
    try {
      const journal = new BridgeJournal(p.bridgeState);
      const health = await journal.workerStatus(now);
      const item = journal.pending();
      // A running queue worker is transport health, not runtime tool readiness or native wake.
      return { ...base, transport: journal.stopped() ? "stopped" : health.healthy ? "running" : "unavailable",
        worker: health.state, delivery: item?.id ?? null,
        phase: item ? journal.receipt(item.id) ? "handled" : journal.queued(item.id) ? "queued" : "pending" : "idle" };
    } catch { return { ...base, transport: "unavailable" }; }
  }));
  return { version: 1, workspace: input.workspace, construct: { id: input.construct.id, url: input.construct.url },
    observedAt: new Date(now).toISOString(), source: sourceStatus(input.sourceHealthFile, now, input.staleAfterMs),
    participants, semantics: "Read-only observation. Enrolment, queued delivery and a running process do not establish tool readiness, handling or native wake." };
}

const escape = (v: unknown) => String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export function renderWorkspaceStatus(status: Awaited<ReturnType<typeof workspaceStatus>>): string {
  const rows = status.participants.map(p => `<tr><td>${escape(p.actor)}</td><td>${escape(p.mode)}</td><td>${escape(p.transport)}</td><td>${escape(p.phase)}</td><td>${escape(p.capabilityReadiness)}</td><td>${escape(p.nativeWake)}</td></tr>`).join("\n");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(status.workspace)} · continuity</title>
<style>body{font:16px system-ui;background:#f6f5f0;color:#18251e;max-width:1100px;margin:48px auto;padding:0 24px}h1{font-size:32px}table{border-collapse:collapse;width:100%;background:white}th,td{text-align:left;padding:14px;border-bottom:1px solid #ddd}small,p{line-height:1.6}.card{background:white;padding:24px;margin:24px 0;border:1px solid #deded5;border-radius:12px}a{color:#20643d}.table{overflow:auto}</style>
<p>SHARED WORKSPACE / CONTINUITY</p><h1>${escape(status.workspace)}</h1><p><a href="${escape(status.construct.url)}">Open Construct ${escape(status.construct.id)}</a></p>
<div class="card"><h2>Ticket source: ${escape(status.source.state)}</h2><p>Ready: ${status.source.ready ? "yes" : "no"}. Evidence freshness: ${status.source.fresh ? "fresh" : "stale or unknown"}.</p><small>Last successful read: ${escape(status.source.lastSuccess ?? "unknown")}</small></div>
<div class="table"><table><thead><tr><th>Participant</th><th>Mode</th><th>Transport</th><th>Delivery</th><th>Tools</th><th>Native wake</th></tr></thead><tbody>${rows}</tbody></table></div>
<p>${escape(status.semantics)}</p><small>Snapshot: ${escape(status.observedAt)}. This page does not refresh itself.</small></html>\n`;
}

export async function workspaceMain(argv: string[]): Promise<number> {
  if (argv.includes("--help")) { console.log("monitor-protocol workspace status --config FILE [--html]\nRead-only JSON or standalone HTML for a shared workspace. No model or monitor starts."); return 0; }
  if (argv[0] !== "status" || argv[1] !== "--config" || !argv[2] ||
      (argv.length !== 3 && !(argv.length === 4 && argv[3] === "--html")))
    throw new Error("expected workspace status --config FILE [--html]");
  const status = await workspaceStatus(JSON.parse(readFileSync(argv[2], "utf8")));
  console.log(argv[3] === "--html" ? renderWorkspaceStatus(status) : JSON.stringify(status, null, 2));
  return 0;
}
