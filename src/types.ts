import type { Capability, Gap, Horizon, Origin, Tier, Verification, Visibility } from "./vocab.js";

/** Nostr-shaped filter (spec/01-objects.md §6): AND across keys, OR within arrays. `#key` matches data.tags. */
export interface Filter {
  types?: string[]; sources?: string[]; subjects?: string[]; actors?: string[];
  tiers?: Tier[]; origins?: Origin[]; horizons?: Horizon[];
  since?: string; until?: string; limit?: number; text?: string;
  [tag: `#${string}`]: string[] | undefined;
}

export interface Rule {
  id: string; version?: string; when: Filter; then: string; derived_from?: string[]; reason?: string;
}

export interface Monitor {
  id: string; name: string; description?: string | null; version: number; owner: string;
  source: { kind: string; ref?: string; settings?: Record<string, unknown> };
  filter: Filter; horizon: Horizon; capabilities: Capability[];
  /** Created against a registration token; a precondition for the top of the provenance ladder. */
  attested?: boolean;
  /** What a subscriber is granted without the owner or subscribe token. */
  default_grant?: Capability[];
  cadence: { heartbeat_seconds?: number; schedule?: string; event_driven?: boolean };
  ttl_seconds?: number | null; retire_after_mute_seconds?: number | null;
  budget?: { currency: string; per_day: number } | null; visibility: Visibility;
  rules: Rule[]; types: string[]; limits: Record<string, unknown>;
  created: string; updated: string; active: boolean; head: number;
}

export interface Provenance {
  origin: Origin; tier: Tier; verification: Verification; actor: string;
  source_ref?: string | null; rule?: string | null;
  wasDerivedFrom?: { source: string; id: string }[]; wasAttributedTo?: string;
  supersedes?: { source: string; id: string } | null;
}

/** A CloudEvents 1.0 event with the protocol's extension attributes (spec/01-objects.md §2). */
export interface Observation {
  specversion: "1.0"; id: string; source: string; type: string; subject?: string | null; time: string;
  datacontenttype?: string; dataschema?: string;
  data: Record<string, unknown> & { provenance: Provenance; tags?: Record<string, unknown> };
  /** CloudEvents allows either; never both. */
  data_base64?: string;
  sequence: string; tier: Tier; origin: Origin; verified: Verification; horizon: Horizon; actor: string;
  redelivered?: boolean; traceparent?: string; tracestate?: string;
}

export interface State {
  monitor: string; as_of: string; as_of_seq: number; covers_until: string | null; head: number;
  retention_floor: number; live: { value: boolean; reason: string | null };
  counters: { observations: number; delivered: number; acted: number; subscriptions_active: number; rejected: number };
  last: { seq: number; time: string; type: string } | null;
  ages: { since_last_observation_s: number | null; since_last_pull_s: number | null; since_last_source_contact_s: number | null };
  contradictions_open: number;
  confidence: { value: number | null; computed_by: string; inputs: { present: string[]; missing: string[] }; gaps: Gap[] };
  computed_from: { seq_from: number; seq_to: number }; ttl_ms: number;
  supersedes: { source: string; id: string } | null;
}

export interface Subscription {
  id: string; monitor: string; subscriber: string; filter: Filter; capabilities: Capability[];
  cursor: number; reset_policy: "earliest" | "latest" | "none"; protocol: "pull" | "http" | "mcp";
  sink?: string | null; sinkcredential?: Record<string, unknown> | null;
  retire_after_mute_seconds?: number | null; created: string;
  last_pull: string | null; active: boolean; lag: number;
}

export interface Lease {
  subject: string; holder: string | null; lease_duration_seconds: number; acquire_time: string;
  renew_time: string; lease_transitions: number; attempts: number; delivery_count_limit: number;
}

export interface PullResult {
  subscription: string; monitor: string; cursor: number; head: number; lag: number; retention_floor: number;
  next: number; redelivered: number; observations: Observation[];
}

export interface ProtocolError { code: string; error: string; done?: unknown[]; [k: string]: unknown }

/** Transport-agnostic result: an HTTP status plus a JSON body. */
export interface Result<T = unknown> { status: number; body: T | ProtocolError; headers?: Record<string, string> }
export interface AuthCtx { bearer?: string | null }
