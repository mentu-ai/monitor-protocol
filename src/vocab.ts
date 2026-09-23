/** Closed vocabularies (spec/01-objects.md). Validated on every write — P11. */
export const PROTOCOL_VERSION = "0.1";
export const EXTENSION_ID = "ai.mentu/monitors";
export const PROTO_PREFIX = "ai.mentu.monitor.";

export const HORIZONS = ["event", "minute", "hour", "day", "week", "month"] as const;
export type Horizon = (typeof HORIZONS)[number];
export const CAPABILITIES = ["observe", "react", "act"] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const TIERS = ["src", "measured", "derived", "unverified", "falsified"] as const;
export type Tier = (typeof TIERS)[number];
export const ORIGINS = ["human", "agent", "webhook", "probe", "system"] as const;
export type Origin = (typeof ORIGINS)[number];
export const VERIFICATIONS = ["human_verified", "machine_verified", "certified", "reported", "unverified"] as const;
export type Verification = (typeof VERIFICATIONS)[number];
export const VISIBILITIES = ["private", "shared", "public"] as const;
export type Visibility = (typeof VISIBILITIES)[number];
export const SOURCE_KINDS = ["shell", "ws", "http", "file", "feed", "cir", "formula", "log"] as const;
export const RESET_POLICIES = ["earliest", "latest", "none"] as const;
export const PROTOCOLS = ["pull", "http", "mcp"] as const;
export const GAPS = ["no_event_provenance", "independence_unknown", "single_actor", "stale_source", "no_subscribers",
  "unattested_origin"] as const;
export type Gap = (typeof GAPS)[number];

/**
 * The most an origin could carry if a human principal stood behind it. Named as ceilings because
 * that is what they are: an observation with no human principal is lowered to MACHINE_CEILING, and
 * nothing is ever defaulted up to these values. Reading `ORIGIN_TIER_CEILING.human === "src"` as
 * "a human origin gets src" is the misreading the rename exists to prevent (P1).
 */
export const ORIGIN_VERIFICATION_CEILING: Record<Origin, Verification> = {
  human: "human_verified", webhook: "machine_verified", probe: "machine_verified",
  system: "machine_verified", agent: "unverified",
};
export const ORIGIN_TIER_CEILING: Record<Origin, Tier> = {
  human: "src", webhook: "measured", probe: "measured", system: "measured", agent: "unverified",
};

/**
 * Reachable only when a human principal stands behind the observation — the monitor's owner, or
 * whoever an agent named in `on_behalf_of`. Everything else caps below them (P1).
 */
export const HUMAN_PRINCIPAL_ONLY = {
  origins: ["human"] as Origin[],
  tiers: ["src"] as Tier[],
  verifications: ["human_verified", "certified"] as Verification[],
} as const;
/** The ceiling a caller with no human principal cannot pass, whatever it declares. */
export const MACHINE_CEILING = { tier: "measured" as Tier, verification: "machine_verified" as Verification };

/** An actor URI's prefix must not contradict the origin it claims. */
export const ORIGIN_OF_ACTOR_PREFIX: Record<string, Origin> = {
  human: "human", user: "human", agent: "agent", system: "system", hook: "webhook", webhook: "webhook", probe: "probe",
};

/** Protocol-defined observation types (spec/01-objects.md §5). */
export const PROTO_TYPES = {
  configured: PROTO_PREFIX + "configured",
  subscribed: PROTO_PREFIX + "subscribed",
  subscriptionRetired: PROTO_PREFIX + "subscription_retired",
  lease: PROTO_PREFIX + "lease",
  state: PROTO_PREFIX + "state",
  bookmark: PROTO_PREFIX + "bookmark",
  rejected: PROTO_PREFIX + "rejected",
  contradiction: PROTO_PREFIX + "contradiction",
  contradictionResolved: PROTO_PREFIX + "contradiction_resolved",
} as const;
export const PROTO_TYPE_LIST: string[] = Object.values(PROTO_TYPES);

export const ERROR_CODES = ["INVALID_FILTER", "UNKNOWN_VOCABULARY", "TIER_NOT_ASSERTABLE", "PROVENANCE_CEILING",
  "INVALID", "CAPABILITY_MISSING", "UNAUTHORIZED", "NOT_FOUND", "DUPLICATE", "CURSOR_BACKWARDS", "CURSOR_EXPIRED",
  "LEASE_HELD", "LEASE_LOST", "EVIDENCE_REQUIRED", "OVER_BUDGET", "ORIGIN_REFUSED", "TOO_LARGE", "UNAVAILABLE"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export const HTTP_OF: Record<ErrorCode, number> = {
  INVALID_FILTER: 400, UNKNOWN_VOCABULARY: 400, TIER_NOT_ASSERTABLE: 400, PROVENANCE_CEILING: 403, INVALID: 400,
  UNAUTHORIZED: 401, CAPABILITY_MISSING: 403, NOT_FOUND: 404, DUPLICATE: 409, CURSOR_BACKWARDS: 409,
  LEASE_HELD: 409, LEASE_LOST: 409, EVIDENCE_REQUIRED: 409, CURSOR_EXPIRED: 410, OVER_BUDGET: 429,
  ORIGIN_REFUSED: 403, TOO_LARGE: 413, UNAVAILABLE: 409,
};
/** JSON-RPC codes in the implementation-defined range; MCP reserves -32020…-32099. */
export const JSONRPC_OF: Record<ErrorCode, number> = {
  INVALID_FILTER: -32000, UNKNOWN_VOCABULARY: -32001, TIER_NOT_ASSERTABLE: -32002, PROVENANCE_CEILING: -32014, INVALID: -32003,
  CAPABILITY_MISSING: -32004, UNAUTHORIZED: -32005, NOT_FOUND: -32006, DUPLICATE: -32007,
  CURSOR_BACKWARDS: -32008, CURSOR_EXPIRED: -32009, LEASE_HELD: -32010, LEASE_LOST: -32011,
  EVIDENCE_REQUIRED: -32012, OVER_BUDGET: -32013, ORIGIN_REFUSED: -32015, TOO_LARGE: -32016, UNAVAILABLE: -32017,
};
export const TYPE_RE = /^[a-z0-9]+(\.[a-z0-9_-]+)+$/;
export const ID_RE = /^[\w.-]{2,64}$/;
