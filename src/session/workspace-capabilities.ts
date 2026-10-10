/** Trusted workspace policy shared across providers; never selected by an observation. */
import {
  admitCapabilityWork, capabilityDigest, type CapabilityAdapter, type CapabilityBinding,
  type CapabilityProfile, type CapabilityReceipt, type RequiredCapability,
} from "./capabilities.js";

export interface WorkspaceCapabilityProfile {
  version: 1;
  id: string;
  ttlMs: number;
  timeoutMs: number;
  /** Semantic capability IDs, required identically for every configured provider. */
  required: string[];
  /** Exact provider names. Each expansion supplies one pinned tool/probe per semantic ID. */
  providers: Record<string, RequiredCapability[]>;
}
export type WorkspaceCapabilityAdmissionCode = "INVALID_WORKSPACE_PROFILE" | "UNAVAILABLE_PROVIDER" |
  "MISSING_CAPABILITY" | "UNEXPECTED_CAPABILITY" | "DUPLICATE_CAPABILITY" | "ADAPTER_UNAVAILABLE";
export class WorkspaceCapabilityAdmissionError extends Error {
  constructor(public readonly code: WorkspaceCapabilityAdmissionCode, message: string) {
    super(message); this.name = "WorkspaceCapabilityAdmissionError";
  }
}
function fail(code: WorkspaceCapabilityAdmissionCode, message: string): never {
  throw new WorkspaceCapabilityAdmissionError(code, message);
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" &&
  !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value: unknown): value is string => typeof value === "string" &&
  value.length > 0 && value.length <= 4096 && !value.includes("\0");

/** Resolve without provider fallback. Concrete tool/probe validation remains in fresh admission. */
export function resolveWorkspaceCapabilityProfile(
  profile: WorkspaceCapabilityProfile, binding: CapabilityBinding,
): CapabilityProfile {
  let p: WorkspaceCapabilityProfile;
  try {
    capabilityDigest(profile); // Reject non-JSON, cyclic, nonfinite, or excessively nested policy.
    const json = JSON.stringify(profile);
    if (Buffer.byteLength(json) > 256 * 1024) throw new Error("oversize");
    p = JSON.parse(json) as WorkspaceCapabilityProfile;
  } catch { return fail("INVALID_WORKSPACE_PROFILE", "Expected bounded JSON workspace policy"); }
  if (!record(p) || p.version !== 1 || !text(p.id) ||
      !Number.isInteger(p.ttlMs) || p.ttlMs < 1 || p.ttlMs > 300_000 ||
      !Number.isInteger(p.timeoutMs) || p.timeoutMs < 1 || p.timeoutMs > 60_000 ||
      !Array.isArray(p.required) || !p.required.length || p.required.length > 32 ||
      !p.required.every(text) || !record(p.providers) || !Object.keys(p.providers).length) {
    fail("INVALID_WORKSPACE_PROFILE", "A nonempty, bounded v1 workspace capability policy is required");
  }
  const required = new Set(p.required);
  if (required.size !== p.required.length) fail("DUPLICATE_CAPABILITY", "Duplicate shared capability ID");
  // Validate every expansion against the same contract, including providers not selected today.
  for (const [provider, expansion] of Object.entries(p.providers)) {
    if (!text(provider) || !Array.isArray(expansion)) {
      fail("INVALID_WORKSPACE_PROFILE", "Provider expansions must be named capability arrays");
    }
    const seen = new Set<string>();
    for (const capability of expansion) {
      if (!record(capability) || !text(capability.id)) {
        fail("INVALID_WORKSPACE_PROFILE", "Every provider capability requires a semantic ID");
      }
      if (seen.has(capability.id)) fail("DUPLICATE_CAPABILITY", "Duplicate provider capability ID");
      if (!required.has(capability.id)) fail("UNEXPECTED_CAPABILITY", "Provider adds an undeclared capability ID");
      seen.add(capability.id);
    }
    if (seen.size !== required.size) fail("MISSING_CAPABILITY", "Provider omits a required capability ID");
  }
  if (!binding || !text(binding.provider) || !Object.hasOwn(p.providers, binding.provider)) {
    fail("UNAVAILABLE_PROVIDER", "No exact capability expansion for this provider");
  }
  const selected = new Map(p.providers[binding.provider].map(capability => [capability.id, capability]));
  return { version: 1, id: p.id, ttlMs: p.ttlMs, timeoutMs: p.timeoutMs,
    required: p.required.map(id => selected.get(id)!) };
}

/** Every invocation resolves policy and probes the supplied owning-session adapter afresh. */
export async function admitWorkspaceCapabilityWork<T>(
  profile: WorkspaceCapabilityProfile, binding: CapabilityBinding,
  adapter: CapabilityAdapter | null | undefined,
  work: (receipt: CapabilityReceipt) => Promise<T> | T,
): Promise<{ receipt: CapabilityReceipt; result: T }> {
  const resolved = resolveWorkspaceCapabilityProfile(profile, binding);
  if (!adapter || typeof adapter.getBinding !== "function" ||
      typeof adapter.inventory !== "function" || typeof adapter.probe !== "function") {
    fail("ADAPTER_UNAVAILABLE", "An owning-session capability adapter is required");
  }
  return admitCapabilityWork(resolved, binding, adapter, work);
}
