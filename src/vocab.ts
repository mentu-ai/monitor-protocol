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
export const GAPS = ["no_event_provenance", "independence_unknown", "single_actor", "stale_source", "no_subscribers"] as const;
export type Gap = (typeof GAPS)[number];

export const DEFAULT_VERIFICATION: Record<Origin, Verification> = {
  human: "human_verified", webhook: "machine_verified", probe: "machine_verified",
  system: "machine_verified", agent: "unverified",
};
export const DEFAULT_TIER: Record<Origin, Tier> = {
  human: "src", webhook: "measured", probe: "measured", system: "measured", agent: "unverified",
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

export const ERROR_CODES = ["INVALID_FILTER", "UNKNOWN_VOCABULARY", "TIER_NOT_ASSERTABLE", "INVALID",
  "CAPABILITY_MISSING", "UNAUTHORIZED", "NOT_FOUND", "DUPLICATE", "CURSOR_BACKWARDS", "CURSOR_EXPIRED",
  "LEASE_HELD", "LEASE_LOST", "EVIDENCE_REQUIRED", "OVER_BUDGET"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export const HTTP_OF: Record<ErrorCode, number> = {
  INVALID_FILTER: 400, UNKNOWN_VOCABULARY: 400, TIER_NOT_ASSERTABLE: 400, INVALID: 400,
  UNAUTHORIZED: 401, CAPABILITY_MISSING: 403, NOT_FOUND: 404, DUPLICATE: 409, CURSOR_BACKWARDS: 409,
  LEASE_HELD: 409, LEASE_LOST: 409, EVIDENCE_REQUIRED: 409, CURSOR_EXPIRED: 410, OVER_BUDGET: 429,
};
/** JSON-RPC codes in the implementation-defined range; MCP reserves -32020…-32099. */
export const JSONRPC_OF: Record<ErrorCode, number> = {
  INVALID_FILTER: -32000, UNKNOWN_VOCABULARY: -32001, TIER_NOT_ASSERTABLE: -32002, INVALID: -32003,
  CAPABILITY_MISSING: -32004, UNAUTHORIZED: -32005, NOT_FOUND: -32006, DUPLICATE: -32007,
  CURSOR_BACKWARDS: -32008, CURSOR_EXPIRED: -32009, LEASE_HELD: -32010, LEASE_LOST: -32011,
  EVIDENCE_REQUIRED: -32012, OVER_BUDGET: -32013,
};
export const TYPE_RE = /^[a-z0-9]+(\.[a-z0-9_-]+)+$/;
export const ID_RE = /^[\w.-]{2,64}$/;
