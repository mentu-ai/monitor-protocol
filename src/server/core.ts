/**
 * MonitorService — the protocol's semantics, independent of transport (spec/02-methods.md).
 * Every method returns {status, body}; HTTP, JSON-RPC and MCP doors map them 1:1.
 */
import { createHash, randomBytes } from "node:crypto";
import { matches, intersectFilters, validateFilter } from "../filter.js";
import { seqstr } from "../cloudevents.js";
import type { LeaseRow, LogEvent, MemoryStore, MonitorRow, SubscriptionRow } from "../store.js";
import type { AuthCtx, Filter, Lease, Monitor, Observation, ProtocolError, PullResult, Result, State, Subscription } from "../types.js";
import { HUMAN_PRINCIPAL_ONLY, CAPABILITIES, ORIGIN_TIER_CEILING, ORIGIN_VERIFICATION_CEILING, EXTENSION_ID, HORIZONS, HTTP_OF, ID_RE,
  ORIGINS, ORIGIN_OF_ACTOR_PREFIX, PROTOCOL_VERSION, PROTOCOLS, PROTO_PREFIX, PROTO_TYPES, PROTO_TYPE_LIST,
  RESET_POLICIES, SOURCE_KINDS, TIERS, TYPE_RE, MACHINE_CEILING, VERIFICATIONS, VISIBILITIES,
  type Capability, type ErrorCode, type Gap, type Origin, type Tier, type Verification } from "../vocab.js";

export interface ServiceOptions {
  serverInfo?: { name: string; version: string; implementation?: string };
  retireAfterMuteDefault?: number;   // seconds, P6
  maxLimit?: number; defaultLimit?: number; maxWaitSeconds?: number;
  /** Actor kind resolver for origin inference: returns "human" | "agent" | "system" | undefined. */
  originOf?: (actor: string) => Origin | undefined;
  /**
   * When set, creating a monitor requires this token and the monitor is marked **attested**: the
   * server established its ownership rather than taking the owner's word for it. This is a
   * disclosure, not a gate — an open server's monitors work identically, and say so in every state
   * they serve through the `unattested_origin` gap (P1).
   */
  registrationToken?: string;
}

// RFC 3339 with milliseconds: a deadline measured in seconds cannot be decided from a timestamp
// truncated to seconds — a 1 s lease would expire early and a 1 s mute threshold never quite late.
const now = (): string => new Date().toISOString();
const plus = (s: number): string => new Date(Date.now() + s * 1000).toISOString();
const ageMs = (iso: string | null | undefined): number | null => iso ? Math.max(0, Date.now() - Date.parse(iso)) : null;
const ageS = (iso: string | null | undefined): number | null => { const ms = ageMs(iso); return ms == null ? null : Math.floor(ms / 1000); };
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const token = (): string => randomBytes(24).toString("base64url");
const asList = (v: unknown): string[] => v == null ? [] : Array.isArray(v) ? v.map(String) : [String(v)];
/** A cursor is an integer or it is nothing: `Number("abc")` is NaN, and NaN passes every comparison. */
const asSeq = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v === "string" && /^\d{1,15}$/.test(v.trim())) return Number(v);
  return null;
};
const digest = (o: unknown): string => sha(JSON.stringify(o, Object.keys(o as object).sort()));

const RULE_ACTION = /^(log|annotate|label|escalate:.+|run:.+|notify:human)$/;
/** P11 applies to `rules` as much as to a filter: a rule stored unchecked is a rule nobody enforces. */
export function validateRules(rules: unknown): string[] {
  if (rules == null) return [];
  if (!Array.isArray(rules)) return ["rules must be an array"];
  const problems: string[] = [];
  rules.forEach((r, i) => {
    const rule = r as Record<string, unknown>;
    if (typeof rule?.id !== "string" || !rule.id) problems.push(`rules[${i}].id is required`);
    if (rule?.when != null && (typeof rule.when !== "object" || Array.isArray(rule.when))) problems.push(`rules[${i}].when must be a filter object`);
    if (typeof rule?.then !== "string" || !RULE_ACTION.test(rule.then)) problems.push(`rules[${i}].then must match ${RULE_ACTION.source}`);
  });
  return problems;
}

export function err(code: ErrorCode, message: string, extra: Record<string, unknown> = {}): Result<never> {
  const body: ProtocolError = { code, error: message, done: [], ...extra };
  return { status: HTTP_OF[code], body };
}
const ok = <T>(body: T, status = 200, headers?: Record<string, string>): Result<T> => ({ status, body, headers });

export class MonitorService {
  readonly opts: Required<Omit<ServiceOptions, "originOf" | "registrationToken">> & Pick<ServiceOptions, "originOf" | "registrationToken">;
  constructor(readonly store: MemoryStore, opts: ServiceOptions = {}) {
    this.opts = {
      serverInfo: opts.serverInfo ?? { name: "monitor-protocol", version: PROTOCOL_VERSION, implementation: "@mentu/monitor-protocol" },
      retireAfterMuteDefault: opts.retireAfterMuteDefault ?? 604800,
      maxLimit: opts.maxLimit ?? 200, defaultLimit: opts.defaultLimit ?? 50, maxWaitSeconds: opts.maxWaitSeconds ?? 50,
      originOf: opts.originOf, registrationToken: opts.registrationToken,
    };
  }

  // ------------------------------------------------------------------ views --
  source(id: string): string { return `monitor:${id}`; }

  toCE(ev: LogEvent): Observation {
    return {
      specversion: "1.0", id: String(ev.seq), source: this.source(ev.monitor), type: ev.type, subject: ev.subject,
      time: ev.time, datacontenttype: "application/json", data: { ...ev.data, provenance: ev.provenance as never },
      sequence: seqstr(ev.seq), tier: ev.tier as never, origin: ev.origin as never, verified: ev.verification as never,
      horizon: ev.horizon as never, actor: ev.actor,
    };
  }

  pubMonitor(m: MonitorRow): Monitor {
    return {
      id: m.id, name: m.name, description: m.description, version: m.version, owner: m.owner, source: m.source as never,
      filter: m.filter, horizon: m.horizon as never, capabilities: m.capabilities as never, cadence: m.cadence as never,
      ttl_seconds: m.ttl_seconds, retire_after_mute_seconds: m.retire_after_mute_seconds, budget: m.budget as never,
      visibility: m.visibility as never, rules: m.rules as never, types: m.types,
      attested: m.attested, default_grant: m.defaultGrant as never,
      limits: { max_limit: this.opts.maxLimit, default_limit: this.opts.defaultLimit, max_wait_seconds: this.opts.maxWaitSeconds,
        retention_floor: this.store.retentionFloor(), auth_required: true },
      created: m.created, updated: m.updated, active: m.active && !m.paused, head: this.store.headOf(m.id),
    };
  }

  pubSubscription(s: SubscriptionRow): Subscription {
    return {
      id: s.id, monitor: s.monitor, subscriber: s.subscriber, filter: s.filter, capabilities: s.capabilities as never,
      cursor: s.cursor, reset_policy: s.reset_policy as never, protocol: s.protocol as never, sink: s.sink,
      retire_after_mute_seconds: s.retire_after_mute_seconds, created: s.created, last_pull: s.lastPull, active: s.active,
      lag: (() => { const m = this.store.monitors.get(s.monitor); return m ? this.pending(m, s) : 0; })(),
    };
  }

  pubLease(l: LeaseRow): Lease {
    return { subject: l.subject, holder: l.holder, lease_duration_seconds: l.lease_duration_seconds, acquire_time: l.acquire_time,
      renew_time: l.renew_time, lease_transitions: l.lease_transitions, attempts: l.attempts, delivery_count_limit: l.delivery_count_limit };
  }

  knownTypes(m?: MonitorRow): string[] {
    const seen = new Set<string>(PROTO_TYPE_LIST);
    if (m) { for (const t of m.types) seen.add(t); for (const e of this.store.events) if (e.monitor === m.id) seen.add(e.type); }
    return [...seen].sort();
  }

  originOf(actor: string): Origin {
    const o = this.opts.originOf?.(actor);
    if (o) return o;
    const p = actor.split(":")[0];
    return ({ human: "human", user: "human", agent: "agent", system: "system", hook: "webhook", webhook: "webhook", probe: "probe" } as Record<string, Origin>)[p] ?? "agent";
  }

  // ------------------------------------------------------------------ auth ---
  private ownerOk(m: MonitorRow, auth: AuthCtx): boolean { return !!auth.bearer && sha(auth.bearer) === m.ownerTokenHash; }
  private grantOk(m: MonitorRow, auth: AuthCtx): boolean { return !!auth.bearer && !!m.subscribeTokenHash && sha(auth.bearer) === m.subscribeTokenHash; }
  /** `public` is open, `shared` needs the grant it was shared with, `private` needs the owner (P14). */
  private visible(m: MonitorRow, auth: AuthCtx): boolean {
    if (m.visibility === "public") return true;
    if (m.visibility === "shared") return this.grantOk(m, auth) || this.ownerOk(m, auth);
    return this.ownerOk(m, auth);
  }
  private authSub(sid: string, auth: AuthCtx): SubscriptionRow | Result<never> {
    const s = this.store.subscriptions.get(sid);
    if (!s) return err("NOT_FOUND", "subscription not found");
    if (!s.active) return err("NOT_FOUND", "subscription retired; re-subscribe to reactivate (cursor kept)", { retired: true, cursor: s.cursor });
    if (!auth.bearer || sha(auth.bearer) !== s.tokenHash) return err("UNAUTHORIZED", "bearer token missing or invalid");
    return s;
  }

  // ---------------------------------------------------------------- sweeps ---
  /** Registration is not consumption (P6): mute subscriptions are retired with a will event. */
  sweep(): number {
    let n = 0;
    for (const s of this.store.subscriptions.values()) {
      if (!s.active) continue;
      const m = this.store.monitors.get(s.monitor);
      const ttl = s.retire_after_mute_seconds ?? m?.retire_after_mute_seconds ?? this.opts.retireAfterMuteDefault;
      const ref = s.lastPull ?? s.created;
      const age = ageMs(ref);
      if (age != null && age > ttl * 1000) {
        s.active = false;
        this.releaseHolder("sub:" + s.id);
        this.log(s.monitor, PROTO_TYPES.subscriptionRetired, null, "system:sweep", "system",
          { subscription: s.id, subscriber: s.subscriber, reason: "mute", mute_since: ref, cursor: s.cursor, retire_after_mute_seconds: ttl });
        n++;
      }
    }
    // expired leases return to the queue (K8s rule: now > renew_time + duration)
    for (const l of this.store.leases.values()) {
      if (l.holder && Date.parse(l.expires) < Date.now()) {
        const holder = l.holder; l.holder = null;
        this.log(l.monitor, PROTO_TYPES.lease, l.subject, "system:sweep", "system", { action: "expired", subject: l.subject, holder });
      }
    }
    return n;
  }
  private releaseHolder(holder: string): void {
    for (const l of this.store.leases.values()) if (l.holder === holder) l.holder = null;
  }

  private log(monitor: string, type: string, subject: string | null, actor: string, origin: Origin, payload: Record<string, unknown>,
    extra: Partial<Pick<LogEvent, "tier" | "verification" | "provenance" | "data">> = {}): LogEvent {
    const m = this.store.monitors.get(monitor);
    const tier = extra.tier ?? "measured";
    const verification = extra.verification ?? ORIGIN_VERIFICATION_CEILING[origin];
    return this.store.append({
      time: now(), monitor, type, subject, actor, tier, origin, verification, horizon: m?.horizon ?? "event",
      data: extra.data ?? { payload, tags: { monitor } },
      provenance: extra.provenance ?? { origin, tier, verification, actor, source_ref: subject, rule: null, wasDerivedFrom: [], wasAttributedTo: actor, supersedes: null },
    });
  }

  // -------------------------------------------------------------- discover ---
  discover(): Result {
    return ok({
      supportedVersions: [PROTOCOL_VERSION], protocol: "monitor-protocol",
      capabilities: { monitors: { listChanged: false, publish: true }, feeds: { pull: true, http: false, mcp: true, sse: true },
        leases: { delivery_count_limit: 5 }, extensions: { [EXTENSION_ID]: { version: PROTOCOL_VERSION } } },
      limits: { max_limit: this.opts.maxLimit, default_limit: this.opts.defaultLimit, max_wait_seconds: this.opts.maxWaitSeconds,
        retire_after_mute_seconds_default: this.opts.retireAfterMuteDefault, retention_floor: this.store.retentionFloor() },
      serverInfo: this.opts.serverInfo, ttlMs: 3600000, cacheScope: "public",
    });
  }

  // -------------------------------------------------------------- monitors ---
  listMonitors(auth: AuthCtx): Result {
    const monitors = [...this.store.monitors.values()].filter(m => this.visible(m, auth)).map(m => this.pubMonitor(m));
    return ok({ monitors, ttlMs: 60000, cacheScope: "private" });
  }
  getMonitor(id: string, auth: AuthCtx): Result {
    const m = this.store.monitors.get(id);
    if (!m || !this.visible(m, auth)) return err("NOT_FOUND", "monitor not found");
    return ok(this.pubMonitor(m));
  }
  createMonitor(b: Record<string, unknown>, actor?: string, auth: AuthCtx = {}): Result {
    const id = String(b.id ?? b.key ?? "").trim() || `mon-${randomBytes(3).toString("hex")}`;
    if (!ID_RE.test(id)) return err("INVALID", "id must match [\\w.-]{2,64}");
    if (this.store.monitors.has(id)) return err("DUPLICATE", "monitor exists; use /update", { id });
    // An open server still creates monitors; what it will not do is call them attested (P1).
    const presented = auth.bearer ?? (b.registration_token as string | undefined) ?? null;
    const required = this.opts.registrationToken;
    if (required && (!presented || presented !== required))
      return err("UNAUTHORIZED", "creating a monitor requires the registration token on this server");
    const attested = !!required;
    const horizon = String(b.horizon ?? "event"), vis = String(b.visibility ?? "private");
    const caps = asList(b.capabilities ?? ["observe"]);
    const src = (b.source as Record<string, unknown>) ?? { kind: "log", ref: "monitor-protocol://log" };
    const bad: string[] = [];
    if (!(HORIZONS as readonly string[]).includes(horizon)) bad.push(`horizon:${horizon}`);
    if (!(VISIBILITIES as readonly string[]).includes(vis)) bad.push(`visibility:${vis}`);
    for (const c of caps) if (!(CAPABILITIES as readonly string[]).includes(c)) bad.push(`capabilities:${c}`);
    if (!(SOURCE_KINDS as readonly string[]).includes(String(src.kind))) bad.push(`source.kind:${src.kind}`);
    if (bad.length) return err("UNKNOWN_VOCABULARY", `invalid values: ${bad.join(", ")}`, { invalid: bad,
      known: { horizon: HORIZONS, visibility: VISIBILITIES, capabilities: CAPABILITIES, "source.kind": SOURCE_KINDS } });
    const ruleProblems = validateRules(b.rules);
    if (ruleProblems.length) return err("UNKNOWN_VOCABULARY", `invalid rules: ${ruleProblems.join(", ")}`, { invalid: ruleProblems });
    const types = asList(b.types);
    for (const t of types) if (!TYPE_RE.test(t)) bad.push(`types:${t}`);
    if (bad.length) return err("UNKNOWN_VOCABULARY", `declared types must be reverse-DNS: ${bad.join(", ")}`, { invalid: bad });
    const v = validateFilter(b.filter ?? {}, [...PROTO_TYPE_LIST, ...types]);
    if (!v.ok) return err("INVALID_FILTER", `invalid filter: ${v.problems.join(", ")}`, { invalid: v.problems, known_keys: v.known_keys, known_types: v.known_types });
    const owner = String(b.owner ?? actor ?? (attested ? "human:owner" : "agent:owner"));
    const grantAsked = asList(b.default_grant ?? ["observe"]);
    const badGrant = grantAsked.filter(c => !(CAPABILITIES as readonly string[]).includes(c) || !caps.includes(c));
    if (badGrant.length) return err("UNKNOWN_VOCABULARY", `default_grant must be a subset of capabilities: ${badGrant.join(", ")}`, { capabilities: caps });
    const wantsSubToken = b.subscribe_token === true || String(b.visibility ?? "private") === "shared";
    const subTok = wantsSubToken ? token() : null;
    const tok = token();
    const t = now();
    const row: MonitorRow = {
      id, name: String(b.name ?? id), description: (b.description as string) ?? null, version: 1, owner, ownerTokenHash: sha(tok),
      source: src, filter: (b.filter as Filter) ?? {}, horizon, capabilities: caps, cadence: (b.cadence as Record<string, unknown>) ?? { event_driven: true },
      ttl_seconds: (b.ttl_seconds as number) ?? null, retire_after_mute_seconds: (b.retire_after_mute_seconds as number) ?? null,
      budget: (b.budget as Record<string, unknown>) ?? null, visibility: vis, rules: (b.rules as unknown[]) ?? [], types,
      created: t, updated: t, active: true, paused: false, lastSourceContact: null,
      attested, defaultGrant: grantAsked, subscribeTokenHash: subTok ? sha(subTok) : null,
    };
    this.store.monitors.set(id, row);
    const after = this.pubMonitor(row);
    this.log(id, PROTO_TYPES.configured, null, owner, this.originOf(owner),
      { action: "create", before_digest: null, after, diff: null, rule: b.rule ?? null, reason: b.reason ?? null, actor: owner });
    return ok({ monitor: after, owner_token: tok, ...(subTok ? { subscribe_token: subTok } : {}),
      notice: "the tokens are shown once" }, 201);
  }
  monitorAction(id: string, action: string, b: Record<string, unknown>, auth: AuthCtx): Result {
    const m = this.store.monitors.get(id);
    if (!m) return err("NOT_FOUND", "monitor not found");
    if (!this.ownerOk(m, auth)) return err("UNAUTHORIZED", "owner bearer token required");
    if (action === "observations" || action === "publish") return this.publish(m, b);
    const before = this.pubMonitor(m);
    if (action === "update") {
      const patch = (b.patch as Record<string, unknown>) ?? {};
      const bad: string[] = [];
      if ("horizon" in patch && !(HORIZONS as readonly string[]).includes(String(patch.horizon))) bad.push(`horizon:${patch.horizon}`);
      if ("visibility" in patch && !(VISIBILITIES as readonly string[]).includes(String(patch.visibility))) bad.push(`visibility:${patch.visibility}`);
      if (bad.length) return err("UNKNOWN_VOCABULARY", `invalid values: ${bad.join(", ")}`, { invalid: bad });
      if ("filter" in patch) {
        const v = validateFilter(patch.filter, this.knownTypes(m));
        if (!v.ok) return err("INVALID_FILTER", `invalid filter: ${v.problems.join(", ")}`, { invalid: v.problems, known_keys: v.known_keys, known_types: v.known_types });
        m.filter = patch.filter as Filter;
      }
      if ("rules" in patch) {
        const rp = validateRules(patch.rules);
        if (rp.length) return err("UNKNOWN_VOCABULARY", `invalid rules: ${rp.join(", ")}`, { invalid: rp });
      }
      for (const k of ["horizon", "visibility", "retire_after_mute_seconds", "name", "description", "source", "cadence", "ttl_seconds", "budget", "rules", "types"] as const)
        if (k in patch) (m as unknown as Record<string, unknown>)[k] = patch[k];
      m.version += 1; m.updated = now();
    } else if (action === "pause") m.paused = true;
    else if (action === "resume") { m.paused = false; m.active = true; }
    else if (action === "retire") {
      m.active = false;
      for (const s of this.store.subscriptions.values()) if (s.monitor === id) this.releaseHolder("sub:" + s.id);
    } else return err("NOT_FOUND", "unknown action");
    const after = this.pubMonitor(m);
    const diff: Record<string, unknown> = {};
    for (const k of Object.keys(after) as (keyof Monitor)[]) if (k !== "head" && JSON.stringify(after[k]) !== JSON.stringify(before[k])) diff[k] = { before: before[k], after: after[k] };
    const ev = this.log(id, PROTO_TYPES.configured, null, m.owner, this.originOf(m.owner),
      { action, before_digest: digest(before), after, diff, rule: b.rule ?? null, reason: b.reason ?? null, actor: m.owner });
    return ok({ monitor: after, seq: ev.seq });
  }

  /**
   * A producer posts one observation (spec 02 `monitors/publish`). P1 and P2 are enforced here.
   *
   * The ceiling, in one place: a monitor whose owner is not a person cannot reach `origin: human`,
   * `tier: src` or a human verification, whatever the request body says. An agent holding a
   * person's monitor token acts at that person's level and names them in `on_behalf_of`; it can
   * name nobody else, so the body can say whose level it is using but never choose it. The body
   * may lower the provenance of its own observation; it may not raise it. A guard that reads its
   * verdict out of the same body it is judging is not a guard. The owner is a claim too unless the
   * server established it, and the server says which: `attested` travels with every observation
   * and every state.
   */
  publish(m: MonitorRow, b: Record<string, unknown>): Result {
    const type = String(b.type ?? "");
    const actor = String(b.actor ?? m.owner);
    // The person an agent acts for is the one the monitor already belongs to: holding its token is
    // the relationship that exists. `on_behalf_of` makes that legible in one field, and the record
    // keeps both names. It may only repeat the owner, so it borrows no one's level.
    const onBehalfOf = b.on_behalf_of == null ? null : String(b.on_behalf_of);
    const mayAttest = m.owner.startsWith("human:");
    const declaredOrigin = b.origin == null ? null : String(b.origin);
    const inferred = this.originOf(actor);
    const origin = (declaredOrigin ?? (mayAttest ? inferred : inferred === "human" ? "agent" : inferred)) as Origin;
    const fallback = ORIGINS.includes(origin) ? ORIGIN_TIER_CEILING[origin] : "unverified";
    const ceilingTier: Tier = mayAttest ? fallback : (HUMAN_PRINCIPAL_ONLY.tiers as string[]).includes(fallback) ? MACHINE_CEILING.tier : fallback;
    const tier = String(b.tier ?? ceilingTier);
    const vFallback = ORIGINS.includes(origin) ? ORIGIN_VERIFICATION_CEILING[origin] : "unverified";
    const ceilingVerification: Verification = mayAttest ? vFallback
      : (HUMAN_PRINCIPAL_ONLY.verifications as string[]).includes(vFallback) ? MACHINE_CEILING.verification : vFallback;
    const verification = String(b.verification ?? ceilingVerification);
    const actorPrefixOrigin = ORIGIN_OF_ACTOR_PREFIX[actor.split(":")[0]] as Origin | undefined;
    const bad: string[] = [];
    if (!TYPE_RE.test(type)) bad.push(`type:${type || "(empty)"}`);
    if (!(TIERS as readonly string[]).includes(tier)) bad.push(`tier:${tier}`);
    if (!(ORIGINS as readonly string[]).includes(origin)) bad.push(`origin:${origin}`);
    if (!(VERIFICATIONS as readonly string[]).includes(verification)) bad.push(`verification:${verification}`);
    let reject: [ErrorCode, string] | null = null;
    if (bad.length) reject = ["UNKNOWN_VOCABULARY", `invalid values: ${bad.join(", ")}`];
    else if (onBehalfOf !== null && onBehalfOf !== m.owner)
      reject = ["PROVENANCE_CEILING", `on_behalf_of names '${onBehalfOf}', but this monitor acts for its owner '${m.owner}': an agent works at the level of the person whose token it holds, not of anyone it names`];
    else if (tier === "src" && origin !== "human") reject = ["TIER_NOT_ASSERTABLE", "a machine cannot assert tier 'src'; a person promotes it on review"];
    // What is refused is a claim that contradicts itself, not a claim the server cannot verify.
    // The server cannot know who is at the keyboard; it can refuse to let a machine assert a human
    // origin with nobody named, and it can disclose, in every state, that nobody independent
    // vouched for the owner. Disclosure carries the weight a gate cannot.
    else if (!mayAttest && (HUMAN_PRINCIPAL_ONLY.origins as string[]).includes(origin))
      reject = ["PROVENANCE_CEILING", `origin '${origin}' needs a human principal; this monitor's owner is '${m.owner}'`];
    else if (!mayAttest && (HUMAN_PRINCIPAL_ONLY.tiers as string[]).includes(tier))
      reject = ["PROVENANCE_CEILING", `tier '${tier}' needs a human principal; this monitor's owner is '${m.owner}'`];
    else if (!mayAttest && (HUMAN_PRINCIPAL_ONLY.verifications as string[]).includes(verification))
      reject = ["PROVENANCE_CEILING", `verification '${verification}' needs a human principal; this monitor's owner is '${m.owner}'`];
    // The actor prefix is a ceiling, not an equality: a monitor owned by an agent may report a
    // probe's observation. An agent may carry a human origin only when it names who it acts for.
    else if ((HUMAN_PRINCIPAL_ONLY.origins as string[]).includes(origin) && actorPrefixOrigin && actorPrefixOrigin !== "human" && !onBehalfOf)
      reject = ["PROVENANCE_CEILING", `actor '${actor}' cannot carry origin '${origin}' unless it names the person it acts for (on_behalf_of: '${m.owner}')`];
    if (reject) {
      const ev = this.log(m.id, PROTO_TYPES.rejected, (b.subject as string) ?? null, "system:guard", "system",
        { code: reject[0], reason: reject[1], raw: b, actor });
      return err(reject[0], reject[1], { invalid: bad, rejected_seq: ev.seq, known: { tier: TIERS, origin: ORIGINS, verification: VERIFICATIONS } });
    }
    const provenance = { origin, tier, verification, actor, on_behalf_of: onBehalfOf,
      attested: m.attested, source_ref: (b.source_ref as string) ?? (b.subject as string) ?? null,
      rule: (b.rule as string) ?? null, wasDerivedFrom: (b.wasDerivedFrom as unknown[]) ?? [], wasAttributedTo: actor,
      supersedes: (b.supersedes as Record<string, unknown>) ?? null };
    const data = { ...((b.data as Record<string, unknown>) ?? {}), tags: { ...((b.tags as Record<string, unknown>) ?? {}), monitor: m.id, origin } };
    const ev = this.store.append({ time: (b.time as string) ?? now(), monitor: m.id, type, subject: (b.subject as string) ?? null, actor,
      tier, origin, verification, horizon: m.horizon, data, provenance });
    m.lastSourceContact = ev.time;
    return ok({ observation: this.toCE(ev), seq: ev.seq }, 201);
  }

  // ---------------------------------------------------------------- state ---
  state(id: string, auth: AuthCtx): Result {
    const m = this.store.monitors.get(id);
    if (!m || !this.visible(m, auth)) return err("NOT_FOUND", "monitor not found");
    return ok(this.computeState(m));
  }
  computeState(m: MonitorRow): State {
    const rows = this.store.events.filter(e => e.monitor === m.id && matches(m.filter, this.toCE(e)));
    const subs = [...this.store.subscriptions.values()].filter(s => s.monitor === m.id && s.active);
    const last = rows.at(-1);
    const actors = new Set(rows.map(r => r.actor).filter(a => !a.startsWith("system:")));
    const lastPull = subs.map(s => s.lastPull ?? "").sort().pop() || null;
    const ageObs = last ? ageS(last.time) : null;
    const contradictions = rows.filter(r => r.type.endsWith(".contradiction")).length - rows.filter(r => r.type.endsWith(".contradiction_resolved")).length;
    const gaps: Gap[] = ["independence_unknown"];
    if (rows.some(r => !r.provenance || !("origin" in r.provenance))) gaps.push("no_event_provenance");
    if (actors.size === 1) gaps.push("single_actor");
    if (m.ttl_seconds && ageObs != null && ageObs > m.ttl_seconds) gaps.push("stale_source");
    if (!subs.length) gaps.push("no_subscribers");
    // Not a fault: a statement of posture. On an open server nobody independent vouched for the
    // owner, and a reader deciding how much to lean on this state is entitled to know that.
    if (!m.attested) gaps.push("unattested_origin");
    const live = !m.active ? { value: false, reason: "retired" } : m.paused ? { value: false, reason: "paused" } : { value: true, reason: null };
    return {
      monitor: m.id, as_of: now(), as_of_seq: this.store.headOf(m.id), covers_until: m.lastSourceContact ?? last?.time ?? null,
      head: this.store.headOf(m.id), retention_floor: this.store.retentionFloor(), live,
      counters: { observations: rows.length, delivered: subs.reduce((a, s) => a + s.delivered, 0),
        acted: rows.filter(r => r.type === PROTO_TYPES.lease && (r.data.payload as Record<string, unknown>)?.action === "complete").length,
        subscriptions_active: subs.length, rejected: rows.filter(r => r.type === PROTO_TYPES.rejected).length },
      last: last ? { seq: last.seq, time: last.time, type: last.type } : null,
      ages: { since_last_observation_s: ageObs, since_last_pull_s: ageS(lastPull), since_last_source_contact_s: ageS(m.lastSourceContact) },
      contradictions_open: Math.max(0, contradictions),
      confidence: { value: null, computed_by: "@mentu/monitor-protocol/" + PROTOCOL_VERSION,
        inputs: { present: ["observations", "ages", "actors", "contradictions_open"], missing: ["independence", "corroboration", "track_record"] }, gaps },
      computed_from: { seq_from: this.store.retentionFloor(), seq_to: this.store.headOf(m.id) }, ttl_ms: 60000, supersedes: null,
    };
  }

  // ---------------------------------------------------------- subscriptions ---
  subscribe(b: Record<string, unknown>, auth: AuthCtx): Result {
    const m = this.store.monitors.get(String(b.monitor ?? ""));
    if (!m || !this.visible(m, auth)) return err("NOT_FOUND", "monitor not found or not visible");
    const subscriber = String(b.subscriber ?? "").trim();
    if (!subscriber) return err("INVALID", "subscriber required");
    const caps = asList(b.capabilities ?? ["observe"]);
    const badCaps = caps.filter(c => !(CAPABILITIES as readonly string[]).includes(c));
    if (badCaps.length) return err("UNKNOWN_VOCABULARY", `invalid capabilities: ${badCaps.join(", ")}`, { known: CAPABILITIES });
    // What a stranger may hold is the monitor's default grant; the full set needs the owner token
    // or the subscribe token it was shared with. Asking is not a grant (P7).
    const privileged = this.ownerOk(m, auth) || this.grantOk(m, auth);
    const grantable = privileged ? m.capabilities : m.capabilities.filter(c => m.defaultGrant.includes(c));
    const over = caps.filter(c => !grantable.includes(c));
    if (over.length) return err("CAPABILITY_MISSING", `this credential may be granted ${JSON.stringify(grantable)}; asked ${JSON.stringify(over)}`, { granted: grantable, monitor_capabilities: m.capabilities });
    if (m.subscribeTokenHash && !privileged) return err("UNAUTHORIZED", "this monitor is shared by token; present it to subscribe");
    const v = validateFilter(b.filter ?? {}, this.knownTypes(m));
    if (!v.ok) return err("INVALID_FILTER", `invalid filter: ${v.problems.join(", ")}`, { invalid: v.problems, known_keys: v.known_keys, known_types: v.known_types });
    const protocol = String(b.protocol ?? "pull"), reset = String(b.reset_policy ?? "none");
    if (!(PROTOCOLS as readonly string[]).includes(protocol)) return err("UNKNOWN_VOCABULARY", `protocol must be one of ${PROTOCOLS.join(", ")}`);
    if (!(RESET_POLICIES as readonly string[]).includes(reset)) return err("UNKNOWN_VOCABULARY", `reset_policy must be one of ${RESET_POLICIES.join(", ")}`);
    const head = this.store.headOf(m.id);
    const existing = [...this.store.subscriptions.values()].find(s => s.monitor === m.id && s.subscriber === subscriber);
    const from = b.from;
    if (from != null && from !== "head" && asSeq(from) == null) return err("INVALID", "`from` must be 'head' or a non-negative integer", { from });
    const tok = token();
    let row: SubscriptionRow;
    if (existing) {
      let cursor = existing.cursor;
      if (from === "head") cursor = head + 1;
      else if (from != null) { const n = asSeq(from)!; if (n < existing.cursor) return err("CURSOR_BACKWARDS", "a cursor does not move backwards; use /seek with a reason", { cursor: existing.cursor, requested: n }); cursor = n; }
      Object.assign(existing, { tokenHash: sha(tok), filter: (b.filter as Filter) ?? {}, capabilities: caps, cursor, protocol, sink: (b.sink as string) ?? null,
        reset_policy: reset, retire_after_mute_seconds: (b.retire_after_mute_seconds as number) ?? null, active: true, lastPull: now() });
      row = existing;
    } else {
      const cursor = from === "head" ? head + 1 : from != null ? asSeq(from)! : 0;
      row = { id: `sub-${randomBytes(4).toString("hex")}`, monitor: m.id, subscriber, tokenHash: sha(tok), filter: (b.filter as Filter) ?? {}, capabilities: caps,
        cursor, deliveredMax: cursor, delivered: 0, protocol, sink: (b.sink as string) ?? null, reset_policy: reset,
        retire_after_mute_seconds: (b.retire_after_mute_seconds as number) ?? null, created: now(), lastPull: now(), active: true };
      this.store.subscriptions.set(row.id, row);
    }
    this.log(m.id, PROTO_TYPES.subscribed, null, subscriber, this.originOf(subscriber),
      { subscription: row.id, subscriber, filter: row.filter, capabilities: caps, cursor: row.cursor, renewed: !!existing });
    return ok({ subscription: this.pubSubscription(row), token: tok, notice: "the token is shown once" }, 201);
  }

  /**
   * Read from `cursor` **inclusive** — the cursor is the next seq to deliver, as the spec and Kafka
   * both define it. Monitor filter ∧ subscription filter ∧ inline filter; never commits (P4).
   */
  read(m: MonitorRow, f: Filter, cursor: number, limit: number, deliveredMax: number): Observation[] {
    const out: Observation[] = [];
    let cur = cursor - 1, scanned = 0;
    while (out.length < limit && cur < this.store.head() && scanned < 20000) {
      const batch = this.store.after(cur, 400);
      if (!batch.length) break;
      for (const e of batch) {
        scanned++; cur = e.seq;
        if (e.monitor !== m.id) continue;
        const ce = this.toCE(e);
        if (!matches(m.filter, ce) || !matches(f, ce)) continue;
        if (e.seq <= deliveredMax) ce.redelivered = true;
        out.push(ce);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  /**
   * How many observations this subscription would receive if it pulled now — its own filter
   * included. Lag measured against a server-wide head counts traffic the subscriber will never be
   * sent, so it never reaches zero and the natural "pull until lag is 0" loop never terminates.
   * Bounded: this is a reference server, not a broker.
   */
  private pending(m: MonitorRow, s: SubscriptionRow, f: Filter = s.filter, cap = 1000): number {
    return this.read(m, f, s.cursor, cap, -1).length;
  }

  async pull(sid: string, q: { cursor?: number; wait?: number; limit?: number; filter?: Filter }, auth: AuthCtx): Promise<Result<PullResult>> {
    const s = this.authSub(sid, auth);
    if (!("id" in s)) return s as Result<never>;
    const m = this.store.monitors.get(s.monitor);
    if (!m) return err("NOT_FOUND", "monitor gone");
    const limit = Math.min(this.opts.maxLimit, Math.max(1, q.limit ?? this.opts.defaultLimit));
    const wait = Math.min(this.opts.maxWaitSeconds, Math.max(0, q.wait ?? 0));
    const floor = this.store.retentionFloor();
    let replay: number | null = null;
    if (q.cursor != null) {
      replay = asSeq(q.cursor);
      if (replay == null) return err("INVALID", "cursor must be a non-negative integer", { cursor: q.cursor });
      if (floor && replay < floor)
        return err("CURSOR_EXPIRED", "cursor below retention floor; relist from state, then pull from the floor",
          { retention_floor: floor, relist: `monitors/state?id=${s.monitor}`, requested: replay });
    }
    const start = replay ?? s.cursor;   // inclusive: the next seq to deliver
    let f: Filter = s.filter;
    if (q.filter && Object.keys(q.filter).length) {
      const v = validateFilter(q.filter, this.knownTypes(m));
      if (!v.ok) return err("INVALID_FILTER", `invalid filter: ${v.problems.join(", ")}`, { invalid: v.problems, known_keys: v.known_keys, known_types: v.known_types });
      const r = intersectFilters(s.filter, q.filter);
      if (!r.filter) return err("INVALID_FILTER", `inline filter would widen or empty key '${r.clash}'; it may only narrow`, { key: r.clash, stored: s.filter });
      f = r.filter;
    }
    const deadline = Date.now() + wait * 1000;
    let obs: Observation[] = [];
    for (;;) {
      obs = this.read(m, f, start, limit, s.deliveredMax);
      s.lastPull = now();
      if (obs.length || Date.now() >= deadline) break;
      await this.store.waitAppend(Math.min(1000, deadline - Date.now()));
    }
    if (obs.length && replay == null) {
      s.deliveredMax = Math.max(s.deliveredMax, ...obs.map(o => Number(o.id)));
      this.store.persist();     // an empty long-poll iteration writes nothing; a delivery does
    }
    const head = this.store.headOf(s.monitor);
    return ok({ subscription: sid, monitor: s.monitor, cursor: s.cursor, head, lag: this.pending(m, s, f), retention_floor: floor,
      next: obs.length ? Number(obs.at(-1)!.id) + 1 : head + 1, redelivered: obs.filter(o => o.redelivered).length, observations: obs },
      200, { "X-MP-Batch-Type": "application/cloudevents-batch+json" });
  }

  subAction(sid: string, action: string, b: Record<string, unknown>, auth: AuthCtx): Result {
    const s = this.authSub(sid, auth);
    if (!("id" in s)) return s as Result<never>;
    const head = this.store.headOf(s.monitor);
    const m = this.store.monitors.get(s.monitor);
    if (action === "ack") {
      const req = asSeq(b.cursor);
      if (req == null) return err("INVALID", "cursor must be a non-negative integer", { cursor: b.cursor });
      if (req < s.cursor) return err("CURSOR_BACKWARDS", "a cursor does not move backwards; use /seek with a reason", { cursor: s.cursor, requested: req, head });
      const cur = Math.max(0, Math.min(req, head + 1));
      s.delivered += Math.max(0, cur - s.cursor); s.cursor = cur; s.lastPull = now();
      this.store.persist();                       // a commit that does not survive a restart is not a commit
      return ok({ subscription: sid, cursor: cur, head, lag: m ? this.pending(m, s) : 0 });
    }
    if (action === "seek") {
      const req = asSeq(b.cursor), floor = this.store.retentionFloor();
      if (req == null) return err("INVALID", "cursor must be a non-negative integer", { cursor: b.cursor });
      if (floor && req < floor) return err("CURSOR_EXPIRED", "below retention floor", { retention_floor: floor });
      if (!b.reason) return err("INVALID", "seek requires a reason");
      const from = s.cursor; s.cursor = Math.max(0, Math.min(req, head + 1)); s.lastPull = now();
      this.log(s.monitor, PROTO_TYPES.subscribed, null, s.subscriber, this.originOf(s.subscriber), { subscription: sid, subscriber: s.subscriber, seek: { from, to: s.cursor }, reason: b.reason });
      this.store.persist();
      return ok({ subscription: sid, cursor: s.cursor });
    }
    if (action === "renew") { const tok = token(); s.tokenHash = sha(tok); s.lastPull = now(); this.store.persist(); return ok({ subscription: this.pubSubscription(s), token: tok }); }
    if (action === "retire") {
      s.active = false; this.releaseHolder("sub:" + sid);
      const ev = this.log(s.monitor, PROTO_TYPES.subscriptionRetired, null, s.subscriber, this.originOf(s.subscriber),
        { subscription: sid, subscriber: s.subscriber, reason: b.reason ?? "by request", cursor: s.cursor, mute_since: null });
      return ok({ ok: true, subscription: sid, seq: ev.seq, cursor_kept: s.cursor });
    }
    return err("NOT_FOUND", "unknown action");
  }

  // ---------------------------------------------------------------- leases ---
  leaseAction(sid: string, action: string, b: Record<string, unknown>, auth: AuthCtx): Result {
    const s = this.authSub(sid, auth);
    if (!("id" in s)) return s as Result<never>;
    if (!s.capabilities.includes("act")) return err("CAPABILITY_MISSING", "this subscription did not declare 'act'", { capabilities: s.capabilities });
    const subject = String(b.subject ?? "");
    if (!subject) return err("INVALID", "subject required");
    const holder = "sub:" + sid, t = now();
    let l = this.store.leases.get(subject);
    if (l && l.holder && Date.parse(l.expires) < Date.now()) { l.holder = null; }   // lazy expiry, same rule as sweep
    if (action === "claim") {
      const dur = Number(b.lease_duration_seconds ?? 900);
      if (l && l.holder && l.holder !== holder) return err("LEASE_HELD", "subject is held by another holder", { holder: l.holder, renew_time: l.renew_time, expires: l.expires });
      const same = !!l && l.holder === holder;
      if (!l) { l = { subject, holder, lease_duration_seconds: dur, acquire_time: t, renew_time: t, expires: plus(dur), lease_transitions: 0, attempts: 1, delivery_count_limit: 5, monitor: s.monitor }; this.store.leases.set(subject, l); }
      else if (!same) { l.lease_transitions += 1; l.attempts += 1; l.holder = holder; l.acquire_time = t; l.renew_time = t; l.lease_duration_seconds = dur; l.expires = plus(dur); }
      if (!same) this.log(s.monitor, PROTO_TYPES.lease, subject, s.subscriber, this.originOf(s.subscriber),
        { action: "claim", subject, subscription: sid, lease_duration_seconds: dur, renew_time: t, expires: l.expires, note: b.note ?? null });
      return ok({ lease: this.pubLease(l), expires: l.expires, idempotent: same }, same ? 200 : 201);
    }
    if (!l || l.holder !== holder) return err("LEASE_LOST", "this subscription no longer holds the lease", { holder: l?.holder ?? null });
    if (action === "renew") {
      const dur = Number(b.lease_duration_seconds ?? l.lease_duration_seconds);
      l.renew_time = t; l.lease_duration_seconds = dur; l.expires = plus(dur);
      this.log(s.monitor, PROTO_TYPES.lease, subject, s.subscriber, this.originOf(s.subscriber), { action: "renew", subject, subscription: sid, renew_time: t, expires: l.expires, note: b.note ?? null });
      return ok({ lease: this.pubLease(l), expires: l.expires });
    }
    if (action === "complete") {
      this.store.leases.delete(subject);
      const ev = this.log(s.monitor, PROTO_TYPES.lease, subject, s.subscriber, this.originOf(s.subscriber),
        { action: "complete", subject, subscription: sid, outcome: b.outcome ?? null, evidence: b.evidence ?? [], note: b.note ?? null });
      return ok({ ok: true, seq: ev.seq });
    }
    if (action === "release" || action === "reject") {
      l.holder = null; l.renew_time = t;
      const dead = action === "reject" && l.attempts >= l.delivery_count_limit;
      const ev = this.log(s.monitor, PROTO_TYPES.lease, subject, s.subscriber, this.originOf(s.subscriber),
        { action, subject, subscription: sid, reason: b.reason ?? "unstated", attempts: l.attempts, dead_letter: dead });
      return ok({ ok: true, seq: ev.seq, dead_letter: dead });
    }
    return err("NOT_FOUND", "unknown action");
  }
}
