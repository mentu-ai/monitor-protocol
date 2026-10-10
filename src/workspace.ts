/** Read-only status projection for a shared workspace and its Construct views. */
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { BridgeJournal, type Delivery } from "./session/bridge.js";
import { assertCapabilityReceipt, capabilityDigest, CapabilityAdmissionError,
  type CapabilityBinding, type CapabilityProfile, type CapabilityReceipt } from "./session/capabilities.js";

export interface WorkspaceConfig {
  version: 1;
  workspace: string;
  construct: { id: string; url: string };
  sourceHealthFile: string;
  staleAfterMs: number;
  participants: Array<{ actor: string; mode: "attended-session" | "bounded-routine";
    bridgeState?: string; handlingWithinMs?: number;
    /** A provider-resolved profile and the receipt preflight issued against it (absolute paths). */
    capability?: { profileFile: string; receiptFile: string } }>;
}

/** Host hook: the participant's binding, obtained live in this call; null when it cannot be. */
export interface WorkspaceStatusOptions {
  liveBinding?: (actor: string) => Promise<CapabilityBinding | null>;
}

export type CapabilityReadiness = "unverified" | "verified" | "expired" | "binding-mismatch" |
  "binding-unavailable" | "evidence-invalid";

export interface WorkspaceHandling {
  state: "unobserved" | "no-pending-delivery" | "awaiting-handling" | "handling-overdue" |
    "handled-awaiting-ack" | "evidence-invalid";
  createdAt: string | null;
  ageMs: number | null;
  dueAt: string | null;
  handledAt: string | null;
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
        (p.bridgeState !== undefined && (!nonempty(p.bridgeState) || !isAbsolute(p.bridgeState))) ||
        (p.handlingWithinMs !== undefined && (!Number.isSafeInteger(p.handlingWithinMs) ||
          Number(p.handlingWithinMs) < 1000 || Number(p.handlingWithinMs) > 86_400_000)) ||
        (p.capability !== undefined && (!object(p.capability) ||
          ![p.capability.profileFile, p.capability.receiptFile].every(f => nonempty(f) && isAbsolute(f as string)))))
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

const emptyHandling = (state: WorkspaceHandling["state"]): WorkspaceHandling => ({
  state, createdAt: null, ageMs: null, dueAt: null, handledAt: null,
});
// BridgeJournal writes canonical ISO timestamps. Reject malformed or ambiguous
// evidence rather than copying arbitrary strings into the public projection.
function journalTime(value: unknown): number {
  const parsed = time(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : NaN;
}
function handlingStatus(journal: BridgeJournal, item: Delivery | null, now: number, within?: number): WorkspaceHandling {
  if (!item) return emptyHandling("no-pending-delivery");
  try {
    const created = journalTime(item.created);
    if (!Number.isFinite(created) || created > now) return emptyHandling("evidence-invalid");
    const receipt = journal.receipt(item.id);
    const handled = receipt ? journalTime(receipt.handled) : null;
    if (handled !== null && (!Number.isFinite(handled) || handled < created || handled > now))
      return emptyHandling("evidence-invalid");
    const ageMs = now - created;
    return { state: receipt ? "handled-awaiting-ack" : within !== undefined && ageMs >= within ? "handling-overdue" : "awaiting-handling",
      createdAt: new Date(created).toISOString(), ageMs,
      dueAt: within === undefined ? null : new Date(created + within).toISOString(),
      handledAt: handled === null ? null : new Date(handled).toISOString() };
  } catch { return emptyHandling("evidence-invalid"); }
}

/**
 * Verified only from a retained receipt that passes integrity, profile, binding and freshness
 * checks now, against a binding the host obtained live in this same call. A saved receipt
 * alone, or a binding from an earlier call, never makes a participant ready.
 */
async function capabilityStatus(p: WorkspaceConfig["participants"][number], now: number,
  options: WorkspaceStatusOptions): Promise<{ readiness: CapabilityReadiness; expiresAt: string | null }> {
  const unverified = { readiness: "unverified" as const, expiresAt: null };
  if (!p.capability || !options.liveBinding) return unverified;
  let profile: CapabilityProfile, receipt: CapabilityReceipt;
  try {
    profile = JSON.parse(readFileSync(p.capability.profileFile, "utf8"));
    receipt = JSON.parse(readFileSync(p.capability.receiptFile, "utf8"));
  } catch { return { readiness: "evidence-invalid", expiresAt: null }; }
  let live: CapabilityBinding | null;
  try { live = await options.liveBinding(p.actor); } catch { live = null; }
  if (!live) return { readiness: "binding-unavailable", expiresAt: null };
  try {
    if (!object(receipt) || capabilityDigest(receipt.binding) !== capabilityDigest(live))
      return { readiness: "binding-mismatch", expiresAt: null };
    assertCapabilityReceipt(receipt, profile, live, now);
    return { readiness: "verified", expiresAt: receipt.expiresAt };
  } catch (error) {
    return { readiness: error instanceof CapabilityAdmissionError && error.code === "EXPIRED_RECEIPT" ? "expired" : "evidence-invalid",
      expiresAt: null };
  }
}

export async function workspaceStatus(input: unknown, now = Date.now(), options: WorkspaceStatusOptions = {}) {
  validateWorkspaceConfig(input);
  const participants = await Promise.all(input.participants.map(async p => {
    const capability = await capabilityStatus(p, now, options);
    const base = { actor: p.actor, mode: p.mode, transport: "unconfigured", worker: "unknown",
      delivery: null as string | null, phase: "unknown", capabilityReadiness: capability.readiness as CapabilityReadiness,
      capabilityExpiresAt: capability.expiresAt, nativeWake: "unverified", handling: emptyHandling("unobserved") };
    if (!p.bridgeState) return base;
    try {
      const journal = new BridgeJournal(p.bridgeState);
      // Worker diagnostics are independent of durable delivery/handling evidence.
      // An unreadable worker record must not conceal a readable overdue delivery.
      const health = await journal.workerStatus(now).catch(() => null);
      const item = journal.pending();
      const handling = handlingStatus(journal, item, now, p.handlingWithinMs);
      // A running queue worker is transport health, not runtime tool readiness or native wake.
      let transport = "unavailable", phase = "unknown";
      try { transport = journal.stopped() ? "stopped" : health?.healthy ? "running" : "unavailable"; }
      catch { /* Invalid transport markers cannot erase independent handling evidence. */ }
      if (handling.state !== "evidence-invalid") {
        try { phase = item ? handling.state === "handled-awaiting-ack" ? "handled" : journal.queued(item.id) ? "queued" : "pending" : "idle"; }
        catch { /* Queue acceptance is unknown, but the receipt deadline still applies. */ }
      }
      return { ...base, transport, worker: health?.state ?? "unknown", delivery: item?.id ?? null, handling, phase };
    } catch (error) { return { ...base, transport: "unavailable", handling:
      emptyHandling((error as NodeJS.ErrnoException).code === "ENOENT" ? "unobserved" : "evidence-invalid") }; }
  }));
  return { version: 1, workspace: input.workspace, construct: { id: input.construct.id, url: input.construct.url },
    observedAt: new Date(now).toISOString(), source: sourceStatus(input.sourceHealthFile, now, input.staleAfterMs),
    participants, semantics: "Read-only observation. Enrolment, queued delivery and a running process do not establish tool readiness, handling or native wake. Tool readiness is verified only from a fresh receipt checked against a binding obtained live in the same observation." };
}

const escape = (v: unknown) => String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export function renderWorkspaceStatus(status: Awaited<ReturnType<typeof workspaceStatus>>): string {
  const rows = status.participants.map(p => `<tr><td>${escape(p.actor)}</td><td>${escape(p.mode)}</td><td>${escape(p.transport)}</td><td>${escape(p.phase)}</td><td>${escape(p.handling.state)}<br><small>Created: ${escape(p.handling.createdAt ?? "unknown")}. Age: ${escape(p.handling.ageMs === null ? "unknown" : `${p.handling.ageMs} ms`)}. Due: ${escape(p.handling.dueAt ?? "not observed")}. Handled: ${escape(p.handling.handledAt ?? "not observed")}.</small></td><td>${escape(p.capabilityReadiness)}</td><td>${escape(p.nativeWake)}</td></tr>`).join("\n");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(status.workspace)} · continuity</title>
<style>body{font:16px system-ui;background:#f6f5f0;color:#18251e;max-width:1100px;margin:48px auto;padding:0 24px}h1{font-size:32px}table{border-collapse:collapse;width:100%;background:white}th,td{text-align:left;padding:14px;border-bottom:1px solid #ddd}small,p{line-height:1.6}.card{background:white;padding:24px;margin:24px 0;border:1px solid #deded5;border-radius:12px}a{color:#20643d}.table{overflow:auto}</style>
<p>SHARED WORKSPACE / CONTINUITY</p><h1>${escape(status.workspace)}</h1><p><a href="${escape(status.construct.url)}">Open Construct ${escape(status.construct.id)}</a></p>
<div class="card"><h2>Ticket source: ${escape(status.source.state)}</h2><p>Ready: ${status.source.ready ? "yes" : "no"}. Evidence freshness: ${status.source.fresh ? "fresh" : "stale or unknown"}.</p><small>Last successful read: ${escape(status.source.lastSuccess ?? "unknown")}</small></div>
<div class="table"><table><thead><tr><th>Participant</th><th>Mode</th><th>Transport</th><th>Delivery</th><th>Handling</th><th>Tools</th><th>Native wake</th></tr></thead><tbody>${rows}</tbody></table></div>
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
