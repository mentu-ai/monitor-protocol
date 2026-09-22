/**
 * Conformance suite C01–C21 (spec/05-conformance.md), black box over the REST binding.
 * The Python runner in conformance/python/run.py is the language-independent twin; the ids,
 * assertions and notes are kept in step.
 */
import { validateObservation } from "./cloudevents.js";
import { loadSchemas, type SchemaSet } from "./schema.js";
import type { Observation, PullResult, State } from "./types.js";

export const SUITE_VERSION = "0.1";

/** This server keeps millisecond clocks; a second-resolution implementation needs ≥ 2500 ms. */
const LEASE_EXPIRY_WAIT_MS = 1300;
const MUTE_WAIT_MS = 1300;

export type CheckStatus = "PASS" | "FAIL" | "SKIP";
export interface CheckResult { id: string; status: CheckStatus; note: string }
export interface SuiteResult { suite: string; version: string; base: string; pass: number; fail: number; skip: number; results: CheckResult[] }
export interface RunOptions { json?: boolean; admin?: boolean; adminToken?: string; log?: (line: string) => void }

interface Res<T = Record<string, unknown>> { status: number; body: T }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const say = (v: unknown) => JSON.stringify(v)?.slice(0, 220) ?? String(v);

class Suite {
  readonly results: CheckResult[] = [];
  readonly tag = String(Date.now()).slice(-6);
  /** Every object the run saw, kept for C29: the schemas are normative and something must enforce them. */
  private readonly seen: { schema: string; label: string; value: unknown }[] = [];
  private schemas: SchemaSet | null = null;
  constructor(readonly base: string, readonly log: (l: string) => void, readonly admin: boolean, readonly adminToken?: string) {}

  private async req<T = Record<string, unknown>>(method: string, path: string, body?: unknown, token?: string | null): Promise<Res<T>> {
    const res = await fetch(`${this.base}/mp/v0${path}`, {
      method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const t = await res.text();
    let parsed: unknown = {};
    try { parsed = t ? JSON.parse(t) : {}; } catch { parsed = { raw: t.slice(0, 200) }; }
    return { status: res.status, body: parsed as T };
  }

  private saw(schema: string, label: string, value: unknown): void {
    if (value != null) this.seen.push({ schema, label, value });
  }

  private record(id: string, status: CheckStatus, note = ""): void {
    this.results.push({ id, status, note });
    this.log(`${id} ${status}${note ? " — " + note : ""}`);
  }
  private check(id: string, cond: boolean, failNote = "", passNote = ""): boolean {
    this.record(id, cond ? "PASS" : "FAIL", cond ? passNote : failNote);
    return cond;
  }

  private async monitor(name: string, extra: Record<string, unknown> = {}): Promise<{ id: string; token: string }> {
    const r = await this.req<{ monitor: { id: string }; owner_token: string }>("POST", "/monitors", {
      id: `c-${name}-${this.tag}`, name, horizon: "minute", capabilities: ["observe", "react", "act"], visibility: "public",
      source: { kind: "shell", ref: "conformance" },
      types: ["test.conformance.reading", "test.conformance.contradiction", "test.conformance.contradiction_resolved"],
      ...extra,
    });
    if (r.status !== 201) throw new Error(`monitor create failed: ${r.status} ${say(r.body)}`);
    this.saw("monitor", `monitor ${r.body.monitor.id}`, r.body.monitor);
    return { id: r.body.monitor.id, token: r.body.owner_token };
  }
  private async subscribe(monitor: string, who: string, capabilities: string[] = ["observe"], extra: Record<string, unknown> = {}, grantToken?: string) {
    const r = await this.req<{ subscription: { id: string; cursor: number }; token: string }>("POST", "/subscriptions", { monitor, subscriber: `${who}-${this.tag}`, capabilities, ...extra }, grantToken);
    if (r.status !== 201) throw new Error(`subscribe failed: ${r.status} ${say(r.body)}`);
    this.saw("subscription", `subscription for ${who}`, r.body.subscription);
    return { id: r.body.subscription.id, token: r.body.token, cursor: r.body.subscription.cursor };
  }
  private publish(id: string, token: string, extra: Record<string, unknown> = {}) {
    return this.req<{ observation: Observation; code?: string }>("POST", `/monitors/${id}/observations`, {
      type: "test.conformance.reading", subject: "probe-1", data: { value: 1 }, tier: "measured", origin: "probe", ...extra,
    }, token);
  }
  private async pull(sid: string, token: string, q: Record<string, string | number> = {}) {
    const qs = Object.entries(q).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
    const r = await this.req<PullResult & { code?: string; retention_floor?: number; relist?: string; retired?: boolean }>("GET", `/subscriptions/${sid}/pull${qs ? "?" + qs : ""}`, undefined, token);
    if (r.status === 200) for (const o of r.body.observations ?? []) this.saw("observation", `observation ${o.id} (${o.type})`, o);
    else if (r.status >= 400) this.saw("error", `pull error ${r.status}`, r.body);
    return r;
  }

  async run(): Promise<CheckResult[]> {
    const subjects = [1, 2, 3].map(i => `subject-${this.tag}-${i}`);

    const d = await this.req<Record<string, unknown>>("GET", "/discover");
    this.check("C01", d.status === 200 && ["supportedVersions", "capabilities", "serverInfo", "ttlMs"].every(k => k in d.body), `${d.status} ${say(d.body)}`);

    const mon = await this.monitor("base");

    const badKey = await this.req<{ code?: string; known_keys?: string[] }>("POST", "/subscriptions", { monitor: mon.id, subscriber: "x", filter: { typo: ["a"] } });
    this.check("C02", badKey.status === 400 && badKey.body.code === "INVALID_FILTER" && Array.isArray(badKey.body.known_keys), `${badKey.status} ${say(badKey.body)}`);

    const badType = await this.req<{ code?: string; known_types?: string[] }>("POST", "/subscriptions", { monitor: mon.id, subscriber: "x", filter: { types: ["test.conformance.nothing"] } });
    this.check("C03", badType.status === 400 && badType.body.code === "INVALID_FILTER" && Array.isArray(badType.body.known_types), `${badType.status} ${say(badType.body)}`);

    const srcByAgent = await this.publish(mon.id, mon.token, { tier: "src", origin: "agent" });
    this.check("C04", srcByAgent.status === 400 && srcByAgent.body.code === "TIER_NOT_ASSERTABLE", `${srcByAgent.status} ${say(srcByAgent.body)}`);

    const reader = await this.subscribe(mon.id, "reader");
    for (let i = 0; i < 3; i++) {
      const r = await this.publish(mon.id, mon.token, { data: { value: i } });
      if (r.status !== 201) throw new Error(`publish failed: ${r.status} ${say(r.body)}`);
    }
    const p1 = await this.pull(reader.id, reader.token);
    const p2 = await this.pull(reader.id, reader.token);
    const ids1 = p1.body.observations.map(o => o.id), ids2 = p2.body.observations.map(o => o.id);
    this.check("C05", p1.status === 200 && ids1.length > 0 && ids1.join() === ids2.join() && p1.body.cursor === p2.body.cursor, `${say(ids1)} vs ${say(ids2)}`);

    const problems = p1.body.observations.flatMap(o => validateObservation(o).map(x => `${o.id}:${x}`));
    this.check("C09", p1.body.observations.length > 0 && problems.length === 0, say(problems));

    const seqs = p1.body.observations.map(o => o.sequence);
    const sorted = [...seqs].sort();
    this.check("C10", seqs.every(s => /^\d{20}$/.test(s)) && seqs.join() === sorted.join() && new Set(seqs).size === seqs.length, say(seqs.slice(0, 3)));

    const next = p1.body.next;
    const a1 = await this.req("POST", `/subscriptions/${reader.id}/ack`, { cursor: next }, reader.token);
    const back = await this.req<{ code?: string }>("POST", `/subscriptions/${reader.id}/ack`, { cursor: Math.max(0, next - 1) }, reader.token);
    const again = await this.req("POST", `/subscriptions/${reader.id}/ack`, { cursor: next }, reader.token);
    this.check("C06", a1.status === 200 && back.status === 409 && back.body.code === "CURSOR_BACKWARDS" && again.status === 200, `${back.status} ${say(back.body)}`);
    this.check("C20", again.status === 200 && JSON.stringify(again.body) === JSON.stringify(a1.body), `${say(again.body)} vs ${say(a1.body)}`, "ack idempotent");

    const narrow = await this.subscribe(mon.id, "narrow", ["observe"], { filter: { types: ["test.conformance.contradiction"] } });
    const pn = await this.pull(narrow.id, narrow.token);
    const pw = await this.pull(reader.id, reader.token);
    this.check("C07", pn.body.head === pw.body.head && pn.body.observations.length === 0, `${pn.body.head} vs ${pw.body.head}, ${pn.body.observations.length} observations`);

    const widen = await this.pull(narrow.id, narrow.token, { types: "test.conformance.reading" });
    this.check("C08", widen.status === 400 && widen.body.code === "INVALID_FILTER", `${widen.status} ${say(widen.body)}`);

    const observer = await this.subscribe(mon.id, "observer-only");
    const noAct = await this.req<{ code?: string }>("POST", `/subscriptions/${observer.id}/leases/claim`, { subject: subjects[0] }, observer.token);
    this.check("C11", noAct.status === 403 && noAct.body.code === "CAPABILITY_MISSING", `${noAct.status} ${say(noAct.body)}`);

    const wa = await this.subscribe(mon.id, "worker-a", ["observe", "act"], {}, mon.token);
    const wb = await this.subscribe(mon.id, "worker-b", ["observe", "act"], {}, mon.token);
    const race = await Promise.all([wa, wb].map(w => this.req<{ code?: string; holder?: string }>("POST", `/subscriptions/${w.id}/leases/claim`, { subject: subjects[1], lease_duration_seconds: 60 }, w.token)));
    const codes = race.map(r => r.status).sort();
    const loser = race.find(r => r.status === 409);
    this.check("C12", codes.join() === "201,409" && loser?.body.code === "LEASE_HELD" && !!loser?.body.holder, say(race.map(r => [r.status, r.body.code])));
    const winner = race[0].status === 201 ? wa : wb;
    const repeat = await this.req<{ idempotent?: boolean }>("POST", `/subscriptions/${winner.id}/leases/claim`, { subject: subjects[1], lease_duration_seconds: 60 }, winner.token);
    this.check("C20b", repeat.status === 200 && repeat.body.idempotent === true, `${repeat.status} ${say(repeat.body)}`, "claim idempotent");

    const short = await this.req("POST", `/subscriptions/${wa.id}/leases/claim`, { subject: subjects[2], lease_duration_seconds: 1 }, wa.token);
    if (short.status >= 400) throw new Error(`short claim failed: ${short.status} ${say(short.body)}`);
    await sleep(LEASE_EXPIRY_WAIT_MS);
    const taken = await this.req("POST", `/subscriptions/${wb.id}/leases/claim`, { subject: subjects[2], lease_duration_seconds: 60 }, wb.token);
    const late = await this.req<{ code?: string }>("POST", `/subscriptions/${wa.id}/leases/complete`, { subject: subjects[2], outcome: "done" }, wa.token);
    this.check("C13", taken.status === 201 && late.status === 409 && late.body.code === "LEASE_LOST", `${taken.status} / ${late.status} ${say(late.body)}`);

    const witness = await this.subscribe(mon.id, "witness", ["observe"], { filter: { types: ["ai.mentu.monitor.*"] } });
    await this.req("POST", `/monitors/${mon.id}/pause`, { reason: "c14" }, mon.token);
    await this.req("POST", `/monitors/${mon.id}/resume`, { reason: "c14" }, mon.token);
    await this.req("POST", `/subscriptions/${observer.id}/retire`, { reason: "c14" }, observer.token);
    const pwit = await this.pull(witness.id, witness.token, { limit: 200 });
    const pairs = pwit.body.observations.map(o => [o.type, ((o.data.payload ?? {}) as Record<string, unknown>).action]);
    const flat = pairs.map(x => x.join(":"));
    this.check("C14",
      flat.includes("ai.mentu.monitor.configured:pause") && flat.includes("ai.mentu.monitor.configured:resume") && pairs.some(x => x[0] === "ai.mentu.monitor.subscription_retired"),
      say(flat.slice(-8)));

    const st = await this.req<State>("GET", `/monitors/${mon.id}/state`);
    const conf = st.body.confidence;
    this.check("C15",
      st.status === 200 && ["as_of", "covers_until", "live", "confidence"].every(k => k in st.body) &&
      typeof st.body.live === "object" && "value" in st.body.live && "reason" in st.body.live &&
      !!conf && !!conf.inputs && Array.isArray(conf.inputs.missing) && Array.isArray(conf.gaps) &&
      (conf.value === null || conf.inputs.missing.length === 0),
      say(st.body));

    const rej = await this.publish(mon.id, mon.token, { tier: "nonsense" });
    const pwit2 = await this.pull(witness.id, witness.token, { limit: 200 });
    const rejected = pwit2.body.observations.filter(o => o.type === "ai.mentu.monitor.rejected");
    const lastRaw = rejected.length ? ((rejected[rejected.length - 1].data.payload as Record<string, unknown>).raw as Record<string, unknown>) : undefined;
    this.check("C16", rej.status === 400 && rej.body.code === "UNKNOWN_VOCABULARY" && rejected.length > 0 && lastRaw?.tier === "nonsense", `${rej.status} ${say(rej.body)} / ${rejected.length} rejected rows`);

    const priv = await this.monitor("private", { visibility: "private" });
    const anon = await this.req<{ monitors: { id: string }[] }>("GET", "/monitors");
    const owned = await this.req<{ monitors: { id: string }[] }>("GET", "/monitors", undefined, priv.token);
    const anonIds = anon.body.monitors.map(m => m.id), ownIds = owned.body.monitors.map(m => m.id);
    this.check("C18", !anonIds.includes(priv.id) && ownIds.includes(priv.id) && anonIds.includes(mon.id), `anon=${anonIds.includes(priv.id)} owner=${ownIds.includes(priv.id)}`);

    const mute = await this.subscribe(mon.id, "mute", ["observe"], { retire_after_mute_seconds: 1 });
    const pm = await this.pull(mute.id, mute.token);
    await this.req("POST", `/subscriptions/${mute.id}/ack`, { cursor: pm.body.next }, mute.token);
    await sleep(MUTE_WAIT_MS);
    await this.req("GET", "/discover");                       // any request runs the sweep
    const gone = await this.pull(mute.id, mute.token);
    const pwit3 = await this.pull(witness.id, witness.token, { limit: 200 });
    const will = pwit3.body.observations.filter(o => o.type === "ai.mentu.monitor.subscription_retired" && ((o.data.payload ?? {}) as Record<string, unknown>).subscription === mute.id);
    const again2 = await this.req<{ subscription: { id: string; cursor: number } }>("POST", "/subscriptions", { monitor: mon.id, subscriber: `mute-${this.tag}`, capabilities: ["observe"] });
    const kept = again2.status === 201 && again2.body.subscription.cursor === pm.body.next && again2.body.subscription.id === mute.id;
    this.check("C19", gone.status === 404 && gone.body.retired === true && will.length > 0 && kept, `${gone.status} ${say(gone.body)} will=${will.length} kept=${kept}`);

    const o1 = await this.publish(mon.id, mon.token, { data: { value: 41 } });
    const orig = o1.body.observation;
    const o2 = await this.publish(mon.id, mon.token, { data: { value: 42 }, supersedes: { source: orig.source, id: orig.id } });
    const replay = await this.pull(reader.id, reader.token, { cursor: Number(orig.id) - 1, limit: 200 });
    const same = replay.body.observations.find(o => o.id === orig.id);
    const sup = (o2.body.observation?.data?.provenance as { supersedes?: { source: string; id: string } } | undefined)?.supersedes;
    this.check("C21", o2.status === 201 && sup?.source === orig.source && sup?.id === orig.id && !!same && (same.data as { value?: number }).value === 41, `${say(sup)} / ${say(same?.data)}`);

    // C22 — the whole of P4: what was acked does not come back. The ack is computed from the
    // spec's definition of the cursor (next seq to deliver), never echoed from the server.
    const p4 = await this.subscribe(mon.id, "p4-reader");
    const before = await this.pull(p4.id, p4.token, { limit: 200 });
    const seen = before.body.observations.map(o => Number(o.id));
    const ackTo = seen.length ? Math.max(...seen) + 1 : 0;
    await this.req("POST", `/subscriptions/${p4.id}/ack`, { cursor: ackTo }, p4.token);
    const after = await this.pull(p4.id, p4.token, { limit: 200 });
    const returned = after.body.observations.map(o => Number(o.id)).filter(id => seen.includes(id));
    this.check("C22", seen.length > 0 && returned.length === 0, `acked ${ackTo}; ${returned.length} acked observations came back: ${say(returned.slice(0, 5))}`);

    // C23 — a wrong credential is refused. Without this the suite passes a server with no auth.
    const badTok = await this.req<{ code?: string }>("GET", `/subscriptions/${p4.id}/pull`, undefined, "not-the-token");
    const noTok = await this.req<{ code?: string }>("GET", `/subscriptions/${p4.id}/pull`);
    this.check("C23", badTok.status === 401 && noTok.status === 401 && badTok.body.code === "UNAUTHORIZED", `wrong token ${badTok.status}, none ${noTok.status}`);

    // C24 — the positive control the lease checks lacked: a completion that succeeds.
    const done = await this.req<{ ok?: boolean }>("POST", `/subscriptions/${wa.id}/leases/claim`, { subject: subjects[0], lease_duration_seconds: 60 }, wa.token);
    const completed = await this.req<{ ok?: boolean }>("POST", `/subscriptions/${wa.id}/leases/complete`, { subject: subjects[0], outcome: "done" }, wa.token);
    this.check("C24", done.status === 201 && completed.status === 200 && completed.body.ok === true, `claim ${done.status}, complete ${completed.status} ${say(completed.body)}`);

    // C25 — head and lag belong to the monitor and the subscription, not to the server.
    const quiet = await this.subscribe(mon.id, "quiet-reader");
    const q1 = await this.pull(quiet.id, quiet.token, { limit: 200 });
    await this.req("POST", `/subscriptions/${quiet.id}/ack`, { cursor: q1.body.observations.length ? Math.max(...q1.body.observations.map(o => Number(o.id))) + 1 : 0 }, quiet.token);
    const caughtUp = await this.pull(quiet.id, quiet.token, { limit: 1 });
    const otherMon = await this.monitor("other");
    await this.publish(otherMon.id, otherMon.token, { subject: "elsewhere" });
    const afterOther = await this.pull(quiet.id, quiet.token, { limit: 1 });
    this.check("C25", caughtUp.body.lag === 0 && afterOther.body.lag === 0 && afterOther.body.head === caughtUp.body.head,
      `lag ${caughtUp.body.lag} → ${afterOther.body.lag}, head ${caughtUp.body.head} → ${afterOther.body.head} after an unrelated monitor published`);

    // C26 — the ceiling, probed with the inputs that do not make the old guard fire.
    const ceiling: [string, Record<string, unknown>][] = [
      ["tier src, origin omitted", { tier: "src" }],
      ["tier src, origin human", { tier: "src", origin: "human" }],
      ["human origin from a non-human actor", { origin: "human", actor: "agent:evil" }],
      ["agent self-certifying", { origin: "agent", verification: "human_verified" }],
    ];
    const escapes: string[] = [];
    for (const [label, body] of ceiling) {
      const r = await this.publish(mon.id, mon.token, body);
      const o = r.body.observation;
      const climbed = r.status < 400 && (o?.tier === "src" || o?.origin === "human" || o?.verified === "human_verified" || o?.verified === "certified");
      if (climbed) escapes.push(`${label} → tier=${o?.tier} origin=${o?.origin} verified=${o?.verified}`);
    }
    this.check("C26", escapes.length === 0, say(escapes));

    // C27 — a cursor that is not an integer is refused, not silently turned into NaN.
    const nan = await this.req<{ code?: string }>("POST", `/subscriptions/${p4.id}/ack`, { cursor: "abc" }, p4.token);
    const nanPull = await this.pull(p4.id, p4.token, { cursor: "abc" as unknown as number });
    this.check("C27", nan.status === 400 && nanPull.status === 400, `ack ${nan.status} ${say(nan.body)}, pull ${nanPull.status}`);

    // C28 — capabilities are granted, not requested (P7): a stranger cannot take work.
    const stranger = await this.req<{ code?: string }>("POST", "/subscriptions", { monitor: mon.id, subscriber: `stranger-${this.tag}`, capabilities: ["observe", "act"] });
    this.check("C28", stranger.status === 403 && stranger.body.code === "CAPABILITY_MISSING", `${stranger.status} ${say(stranger.body)}`);

    // C29 — the schemas are normative, and this is what makes them so.
    const st29 = await this.req<State>("GET", `/monitors/${mon.id}/state`);
    this.saw("state", "state", st29.body);
    const lease29 = await this.req<{ lease?: unknown }>("POST", `/subscriptions/${wb.id}/leases/claim`, { subject: subjects[1], lease_duration_seconds: 30 }, wb.token);
    if (lease29.status < 400) this.saw("lease", "lease", lease29.body.lease);
    const bad29 = await this.req("POST", "/subscriptions", { monitor: mon.id, subscriber: "x", filter: { typo: [1] } });
    this.saw("error", "error body", bad29.body);
    try {
      this.schemas ??= loadSchemas();
      const failures: string[] = [];
      for (const { schema, label, value } of this.seen) {
        const problems = this.schemas.validate(schema, value);
        if (problems.length) failures.push(`${label}: ${problems.map(p => `${p.path} ${p.message}`).join("; ")}`);
      }
      this.check("C29", failures.length === 0, say(failures.slice(0, 3)), `${this.seen.length} objects validated against ${this.schemas.names().length} schemas`);
    } catch (e) {
      this.record("C29", "SKIP", `schemas unavailable to this runner: ${(e as Error).message}`);
    }

    // Compaction is destructive, so the expiry check runs last.
    const head = (await this.pull(reader.id, reader.token, { limit: 1 })).body.head;
    let compacted = false;
    if (this.admin) {
      const c = await this.req<{ retention_floor?: number }>("POST", "/admin/compact", { upto_seq: Math.max(1, head - 1) }, this.adminToken);
      compacted = c.status === 200;
    }
    const floorNow = (await this.pull(reader.id, reader.token, { limit: 1 })).body.retention_floor;
    if (compacted && floorNow > 1) {
      const ex = await this.pull(reader.id, reader.token, { cursor: 0 });
      this.check("C17", ex.status === 410 && ex.body.code === "CURSOR_EXPIRED" && ex.body.retention_floor != null && ex.body.relist != null, `${ex.status} ${say(ex.body)}`);
    } else {
      this.record("C17", "SKIP", `server retains everything (retention_floor=${floorNow}); expiry path not exercisable`);
    }
    return this.results;
  }
}

export async function runConformance(base: string, opts: RunOptions = {}): Promise<SuiteResult> {
  const log = opts.json ? () => undefined : (opts.log ?? ((l: string) => console.log(l)));
  const suite = new Suite(base.replace(/\/$/, ""), log, opts.admin === true, opts.adminToken);
  const results = await suite.run();
  return {
    suite: "monitor-protocol-conformance", version: SUITE_VERSION, base,
    pass: results.filter(r => r.status === "PASS").length,
    fail: results.filter(r => r.status === "FAIL").length,
    skip: results.filter(r => r.status === "SKIP").length,
    results,
  };
}

export function printSummary(r: SuiteResult, json: boolean): void {
  if (json) console.log(JSON.stringify(r, null, 1));
  else console.log(`\n${r.pass} PASS · ${r.fail} FAIL · ${r.skip} SKIP`);
}
