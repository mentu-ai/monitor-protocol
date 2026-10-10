/**
 * Consumer-side capability admission, not a Monitor Protocol wire extension.
 * Profiles and bindings come from trusted host configuration, never observations.
 * MCP v1 checks tools through the owning session's transport; it does not certify
 * native shell tools, app-private connectors, model tool selection, or user authority.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

export type CapabilityJson = null | boolean | number | string | CapabilityJson[] | { [key: string]: CapabilityJson };
export interface CapabilityBinding {
  provider: string;
  sessionId: string;
  /** Unique to this runtime incarnation; change on restart/reconnect. */
  runtimeId: string;
  /** Digest of effective model, tools, permissions, and other host configuration. */
  configSha256: string;
  /** Host-resolved workspace identity; compare exactly, never normalize a request. */
  workspace: string;
}
export interface RequiredCapability {
  id: string;
  server: string;
  tool: string;
  /** capabilityDigest of the full advertised MCP Tool object. */
  toolSha256: string;
  probe: {
    /** Operator's declaration, not a claim inferred from server annotations. */
    kind: "read-only";
    arguments: { [key: string]: CapabilityJson };
    /** Nonempty semantic checks on the returned MCP result, using JSON pointers. */
    assertions: { path: string; equals: CapabilityJson }[];
  };
}
export interface CapabilityProfile {
  version: 1;
  id: string;
  /** Receipt lifetime from the start of preflight, 1..300000 ms. */
  ttlMs: number;
  /** One total deadline, including binding checks and all RPCs, 1..60000 ms. */
  timeoutMs: number;
  required: RequiredCapability[];
}
export interface CapabilityTool {
  server: string;
  tool: { [key: string]: CapabilityJson };
}
export interface CapabilityAdapter {
  getBinding(signal: AbortSignal): Promise<CapabilityBinding>;
  inventory(binding: CapabilityBinding, signal: AbortSignal): Promise<CapabilityTool[]>;
  probe(binding: CapabilityBinding, capability: RequiredCapability, signal: AbortSignal): Promise<unknown>;
}
export interface CapabilityReceipt {
  version: 1;
  kind: "tool-capability-receipt";
  status: "verified";
  runId: string;
  nonce: string;
  binding: CapabilityBinding;
  profileId: string;
  profileSha256: string;
  issuedAt: string;
  expiresAt: string;
  checks: { capability: string; server: string; tool: string; toolSha256: string; resultSha256: string }[];
  receiptSha256: string;
}
export type CapabilityAdmissionCode = "INVALID_PROFILE" | "INVALID_BINDING" | "BINDING_CHANGED" |
  "INVALID_INVENTORY" | "MISSING_CAPABILITY" | "SCHEMA_MISMATCH" | "PROBE_FAILED" |
  "TIMEOUT" | "EXPIRED_RECEIPT" | "INVALID_RECEIPT" | "ADAPTER_FAILED";
export class CapabilityAdmissionError extends Error {
  constructor(public readonly code: CapabilityAdmissionCode, message: string) {
    super(message); this.name = "CapabilityAdmissionError";
  }
}
function fail(code: CapabilityAdmissionCode, message: string): never { throw new CapabilityAdmissionError(code, message); }
const hashPattern = /^sha256:[a-f0-9]{64}$/;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" &&
  !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0");
const deadlines = new WeakMap<AbortSignal, () => void>();
function checkpoint(signal: AbortSignal): void {
  deadlines.get(signal)?.();
  signal.throwIfAborted();
}

function canonical(value: unknown, depth = 0): string {
  if (depth > 32) throw new TypeError("JSON nesting exceeds 32 levels");
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, v => canonical(v, depth + 1)).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k], depth + 1)}`).join(",")}}`;
  throw new TypeError("Expected finite JSON data");
}
/** Stable SHA-256 over sorted UTF-8 JSON, without a trailing newline. Not a signature. */
export function capabilityDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}
function clone<T>(value: T, code: CapabilityAdmissionCode): T {
  try {
    const json = canonical(value);
    if (Buffer.byteLength(json) > 256 * 1024) fail(code, "Configuration or result exceeds 256 KiB");
    return JSON.parse(json) as T;
  } catch (error) {
    if (error instanceof CapabilityAdmissionError) throw error;
    return fail(code, "Expected bounded JSON data");
  }
}
function bindingCopy(binding: CapabilityBinding): CapabilityBinding {
  const b = clone(binding, "INVALID_BINDING");
  if (!record(b) || Object.keys(b).sort().join(",") !== "configSha256,provider,runtimeId,sessionId,workspace" ||
      ![b.provider, b.sessionId, b.runtimeId, b.workspace].every(text) || !hashPattern.test(b.configSha256)) {
    fail("INVALID_BINDING", "Exact provider/session/runtime/config/workspace binding required");
  }
  return b;
}
/** RFC 6901 pointer spelling, scanned once without ambiguous repetition/backtracking. */
function validPointer(path: string): boolean {
  if (path !== "" && !path.startsWith("/")) return false;
  for (let i = 0; i < path.length; i++) {
    if (path[i] !== "~") continue;
    if (path[i + 1] !== "0" && path[i + 1] !== "1") return false;
    i++;
  }
  return true;
}
function profileCopy(profile: CapabilityProfile): CapabilityProfile {
  const p = clone(profile, "INVALID_PROFILE");
  if (!record(p) || p.version !== 1 || !text(p.id) ||
      !Number.isInteger(p.ttlMs) || p.ttlMs < 1 || p.ttlMs > 300_000 ||
      !Number.isInteger(p.timeoutMs) || p.timeoutMs < 1 || p.timeoutMs > 60_000 ||
      !Array.isArray(p.required) || !p.required.length || p.required.length > 32) {
    fail("INVALID_PROFILE", "A bounded, nonempty v1 capability profile is required");
  }
  const ids = new Set<string>(), toolPins = new Map<string, string>();
  for (const c of p.required) {
    if (!record(c) || ![c.id, c.server, c.tool].every(text) || !hashPattern.test(c.toolSha256) ||
        !record(c.probe) || c.probe.kind !== "read-only" || !record(c.probe.arguments) ||
        !Array.isArray(c.probe.assertions) || !c.probe.assertions.length || c.probe.assertions.length > 32) {
      fail("INVALID_PROFILE", "Every capability needs a pinned tool and an operator-defined read-only probe");
    }
    const toolKey = canonical([c.server, c.tool]);
    if (ids.has(c.id)) fail("INVALID_PROFILE", "Duplicate capability ID");
    if (toolPins.has(toolKey) && toolPins.get(toolKey) !== c.toolSha256) {
      fail("INVALID_PROFILE", "Conflicting pins for a shared tool");
    }
    ids.add(c.id); toolPins.set(toolKey, c.toolSha256);
    for (const a of c.probe.assertions) {
      if (!record(a) || typeof a.path !== "string" || a.path.length > 4096 ||
          !validPointer(a.path) || !Object.hasOwn(a, "equals")) {
        fail("INVALID_PROFILE", "Probe assertions require JSON pointers and explicit expected values");
      }
    }
  }
  return p;
}
async function sameBinding(adapter: CapabilityAdapter, binding: CapabilityBinding, signal: AbortSignal): Promise<void> {
  checkpoint(signal);
  const current = bindingCopy(await adapter.getBinding(signal));
  checkpoint(signal);
  if (capabilityDigest(current) !== capabilityDigest(binding)) fail("BINDING_CHANGED", "Session binding changed; admission refused");
}
function pointer(value: unknown, path: string): { found: boolean; value?: unknown } {
  let cursor = value;
  for (const token of path === "" ? [] : path.slice(1).split("/").map(p => p.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if ((!record(cursor) && !Array.isArray(cursor)) || !Object.hasOwn(cursor, token)) return { found: false };
    cursor = (cursor as Record<string, unknown>)[token];
  }
  return { found: true, value: cursor };
}
/** Every operator assertion holds on an MCP tool result: the same check for every host. */
export function capabilityResultMatches(result: unknown, capability: RequiredCapability): boolean {
  return capability.probe.assertions.every(assertion => {
    const actual = pointer(result, assertion.path);
    return actual.found && capabilityDigest(actual.value) === capabilityDigest(assertion.equals);
  });
}
async function bounded<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  deadlines.set(controller.signal, () => {
    if (performance.now() >= deadline && !controller.signal.aborted) {
      controller.abort(new CapabilityAdmissionError("TIMEOUT", "Capability preflight timed out; no work admitted"));
    }
  });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new CapabilityAdmissionError("TIMEOUT", "Capability preflight timed out; no work admitted");
      controller.abort(error); reject(error);
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([run(controller.signal), timeout]);
    checkpoint(controller.signal);
    return result;
  }
  catch (error) {
    if (error instanceof CapabilityAdmissionError) throw error;
    // Do not persist raw RPC errors: they may contain credentials or private content.
    return fail("ADAPTER_FAILED", "Capability adapter failed; no work admitted");
  } finally { if (timer) clearTimeout(timer); }
}

/** Fresh probes every time. A receipt is trusted-host evidence, not a bearer grant. */
export async function preflightCapabilities(
  profile: CapabilityProfile, binding: CapabilityBinding, adapter: CapabilityAdapter,
): Promise<CapabilityReceipt> {
  const p = profileCopy(profile), b = bindingCopy(binding);
  const started = Date.now();
  return bounded(p.timeoutMs, async signal => {
    await sameBinding(adapter, b, signal);
    const inventory = await adapter.inventory(clone(b, "INVALID_BINDING"), signal);
    await sameBinding(adapter, b, signal);
    if (!Array.isArray(inventory) || inventory.length > 10_000) fail("INVALID_INVENTORY", "Invalid tool inventory");
    const tools = new Map<string, CapabilityTool>();
    for (const entry of inventory) {
      if (!record(entry) || !text(entry.server) || !record(entry.tool) || !text(entry.tool.name) || !record(entry.tool.inputSchema)) {
        fail("INVALID_INVENTORY", "Tool inventory contains an invalid tool");
      }
      const key = canonical([entry.server, entry.tool.name]);
      if (tools.has(key)) fail("INVALID_INVENTORY", "Duplicate tool in inventory");
      tools.set(key, entry);
    }
    // Validate every required tool before probing any of them.
    for (const c of p.required) {
      const item = tools.get(canonical([c.server, c.tool]));
      if (!item) fail("MISSING_CAPABILITY", `Missing required capability: ${c.id}`);
      if (capabilityDigest(item.tool) !== c.toolSha256) fail("SCHEMA_MISMATCH", `Tool contract changed: ${c.id}`);
    }
    const checks: CapabilityReceipt["checks"] = [];
    for (const c of p.required) {
      await sameBinding(adapter, b, signal);
      const result = clone(await adapter.probe(clone(b, "INVALID_BINDING"), clone(c, "INVALID_PROFILE"), signal), "PROBE_FAILED");
      await sameBinding(adapter, b, signal);
      if (!record(result) || !Array.isArray(result.content) ||
          (Object.hasOwn(result, "isError") && result.isError !== false)) {
        fail("PROBE_FAILED", `Probe returned an error or malformed result: ${c.id}`);
      }
      if (!capabilityResultMatches(result, c)) fail("PROBE_FAILED", `Probe semantic assertion failed: ${c.id}`);
      checks.push({ capability: c.id, server: c.server, tool: c.tool, toolSha256: c.toolSha256, resultSha256: capabilityDigest(result) });
    }
    await sameBinding(adapter, b, signal);
    if (Date.now() >= started + p.ttlMs) fail("EXPIRED_RECEIPT", "Preflight exceeded receipt lifetime");
    const unsigned = {
      version: 1 as const, kind: "tool-capability-receipt" as const, status: "verified" as const,
      runId: randomUUID(), nonce: randomBytes(32).toString("hex"), binding: b,
      profileId: p.id, profileSha256: capabilityDigest(p), issuedAt: new Date(started).toISOString(),
      expiresAt: new Date(started + p.ttlMs).toISOString(), checks,
    };
    return { ...unsigned, receiptSha256: capabilityDigest(unsigned) };
  });
}

/** Checks retained evidence integrity/binding/freshness; it cannot authenticate its author. */
export function assertCapabilityReceipt(
  receipt: CapabilityReceipt, profile: CapabilityProfile, binding: CapabilityBinding, now = Date.now(),
): void {
  const p = profileCopy(profile), b = bindingCopy(binding), r = clone(receipt, "INVALID_RECEIPT");
  if (!record(r)) fail("INVALID_RECEIPT", "Invalid receipt");
  const { receiptSha256, ...unsigned } = r;
  if (r.version !== 1 || r.kind !== "tool-capability-receipt" || r.status !== "verified" ||
      typeof r.runId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(r.runId) ||
      typeof r.nonce !== "string" || !/^[a-f0-9]{64}$/.test(r.nonce) ||
      receiptSha256 !== capabilityDigest(unsigned) || r.profileId !== p.id || r.profileSha256 !== capabilityDigest(p) ||
      capabilityDigest(r.binding) !== capabilityDigest(b) || !Array.isArray(r.checks) || r.checks.length !== p.required.length) {
    fail("INVALID_RECEIPT", "Receipt integrity, profile, or binding mismatch");
  }
  for (let i = 0; i < p.required.length; i++) {
    const c = p.required[i], check = r.checks[i];
    if (!record(check) || check.capability !== c.id || check.server !== c.server || check.tool !== c.tool ||
        check.toolSha256 !== c.toolSha256 || !hashPattern.test(check.resultSha256)) fail("INVALID_RECEIPT", "Receipt capability mismatch");
  }
  const start = Date.parse(r.issuedAt), end = Date.parse(r.expiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(start) || !Number.isFinite(end) ||
      end - start !== p.ttlMs || now < start || now >= end) fail("EXPIRED_RECEIPT", "Receipt is expired or has an invalid lifetime");
}

/** Always re-probes; never accepts a retained receipt or observation as admission. */
export async function admitCapabilityWork<T>(
  profile: CapabilityProfile, binding: CapabilityBinding, adapter: CapabilityAdapter,
  work: (receipt: CapabilityReceipt) => Promise<T> | T,
): Promise<{ receipt: CapabilityReceipt; result: T }> {
  const p = profileCopy(profile), b = bindingCopy(binding);
  const receipt = await preflightCapabilities(p, b, adapter);
  await bounded(p.timeoutMs, signal => sameBinding(adapter, b, signal));
  assertCapabilityReceipt(receipt, p, b);
  // Call synchronously after validation. The host must hold its session/config lease
  // for the entire asynchronous work; this library cannot lock a remote host.
  const result = await work(clone(receipt, "INVALID_RECEIPT"));
  return { receipt, result };
}

export interface CodexCapabilityRpc {
  /** Already-connected owned app-server transport; reject JSON-RPC errors, honor signal. */
  request(method: string, params: Record<string, unknown>, options: { signal: AbortSignal }): Promise<unknown>;
}

/** Uses the existing thread's actual MCP connections. Never start/resume a thread. */
export class CodexAppServerCapabilities implements CapabilityAdapter {
  constructor(
    private readonly rpc: CodexCapabilityRpc,
    public readonly getBinding: (signal: AbortSignal) => Promise<CapabilityBinding>,
  ) {}

  async inventory(binding: CapabilityBinding, signal: AbortSignal): Promise<CapabilityTool[]> {
    if (binding.provider !== "codex") fail("INVALID_BINDING", "Codex adapter requires provider codex");
    const found: CapabilityTool[] = [], servers = new Set<string>(), cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      checkpoint(signal);
      const response = await this.rpc.request("mcpServerStatus/list", {
        threadId: binding.sessionId, detail: "toolsAndAuthOnly", limit: 100, ...(cursor ? { cursor } : {}),
      }, { signal });
      checkpoint(signal);
      if (!record(response) || !Array.isArray(response.data)) fail("INVALID_INVENTORY", "Invalid Codex MCP inventory response");
      for (const server of response.data) {
        if (!record(server) || !text(server.name) || servers.has(server.name)) fail("INVALID_INVENTORY", "Invalid or duplicate Codex MCP server");
        servers.add(server.name);
        // Cached discovery or a configured-but-disconnected server is insufficient.
        if (server.runtimeStatus !== "connected" || server.toolsError != null) continue;
        if (!record(server.tools)) fail("INVALID_INVENTORY", "Invalid Codex MCP tools map");
        for (const [name, tool] of Object.entries(server.tools)) {
          if (!record(tool) || tool.name !== name) fail("INVALID_INVENTORY", "MCP tool name mismatch");
          found.push({ server: server.name, tool: clone(tool, "INVALID_INVENTORY") as CapabilityTool["tool"] });
        }
      }
      if (response.nextCursor == null) return found;
      if (!text(response.nextCursor) || cursors.has(response.nextCursor)) fail("INVALID_INVENTORY", "Invalid Codex MCP inventory cursor");
      cursor = response.nextCursor; cursors.add(cursor);
    }
    return fail("INVALID_INVENTORY", "Codex MCP inventory exceeded page limit");
  }

  async probe(binding: CapabilityBinding, capability: RequiredCapability, signal: AbortSignal): Promise<unknown> {
    if (binding.provider !== "codex") fail("INVALID_BINDING", "Codex adapter requires provider codex");
    checkpoint(signal);
    return this.rpc.request("mcpServer/tool/call", {
      threadId: binding.sessionId, server: capability.server, tool: capability.tool, arguments: capability.probe.arguments,
    }, { signal });
  }
}
