/** Read one existing subscription without creating, rotating, or resetting it. */
import { loadSchemas } from "../schema.js";
import type { Observation } from "../types.js";

export interface BridgeEvent { event: Observation; next: number }

/** A temporary transport failure; retaining the delivery and retrying is safe. */
export class BridgeRetryError extends Error {
  constructor(message: string) { super(message); this.name = "BridgeRetryError"; }
}

const MAX_RESPONSE_BYTES = 2_000_000;
const REQUEST_TIMEOUT_MS = 5_000;
const schemas = loadSchemas();
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const cursor = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const nonempty = (v: unknown): v is string => typeof v === "string" && v.length > 0 && !/[\u0000-\u0020\u007f]/.test(v);

function canonicalBase(base: string): string {
  let url: URL;
  try { url = new URL(base); } catch { throw new Error("MP base must be an absolute URL"); }
  if (url.username || url.password || url.search || url.hash || base.includes("?") || base.includes("#"))
    throw new Error("MP base must not contain credentials, query, or fragment");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    throw new Error("MP requires HTTPS or loopback HTTP");
  if (!["", "/mp/v0"].includes(url.pathname.replace(/\/+$/, "")))
    throw new Error("MP base path must be the root or /mp/v0");
  return url.origin;
}

/**
 * The bearer stays in this source, never in an event or notification. A subscription belongs to
 * one bridge consumer; the journal/worker is responsible for coordinating that ownership.
 */
export class HttpSubscriptionSource {
  readonly base: string;
  readonly subscription: string;
  private readonly token: string;
  private readonly f: typeof fetch;

  constructor(base: string, subscription: string, token: string, opts: { fetch?: typeof fetch } = {}) {
    this.base = canonicalBase(base);
    if (!nonempty(subscription) || [".", ".."].includes(subscription) || !token.trim() || /[\r\n]/.test(token))
      throw new Error("An existing subscription and its bearer token are required");
    this.subscription = subscription;
    this.token = token;
    this.f = opts.fetch ?? fetch;
  }

  private async request(action: "pull" | "ack", body?: { cursor: number }): Promise<Record<string, unknown>> {
    const url = `${this.base}/mp/v0/subscriptions/${encodeURIComponent(this.subscription)}/${action}${action === "pull" ? "?wait=0&limit=1" : ""}`;
    let response: Response;
    try {
      response = await this.f(url, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: "manual", // Never forward the bearer, including to another path on the same host.
      });
    } catch { throw new BridgeRetryError("MP unavailable; cursor retained"); }

    const discard = () => { void response.body?.cancel().catch(() => {}); };
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      discard();
      throw new Error("MP redirects are refused; cursor retained");
    }
    if (!response.ok) {
      discard();
      if (response.status === 408 || response.status === 429 || response.status >= 500)
        throw new BridgeRetryError(`MP temporarily unavailable (HTTP ${response.status})`);
      throw new Error(`MP refused request (HTTP ${response.status}); no cursor reset performed`);
    }
    if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
      discard();
      throw new Error("MP response exceeds limit");
    }
    if (!response.body) throw new Error("MP response must contain JSON");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try { chunk = await reader.read(); }
        catch { throw new BridgeRetryError("MP response interrupted; cursor retained"); }
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > MAX_RESPONSE_BYTES) {
          void reader.cancel().catch(() => {});
          throw new Error("MP response exceeds limit");
        }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length))); }
    catch { throw new Error("MP response must contain valid UTF-8 JSON"); }
    if (!object(value)) throw new Error("MP response must be an object");
    if (value.subscription !== this.subscription) throw new Error("MP response names another subscription");
    return value;
  }

  async pull(): Promise<BridgeEvent | null> {
    const page = await this.request("pull");
    if (!cursor(page.cursor) || !cursor(page.next) || !cursor(page.head) || !cursor(page.retention_floor))
      throw new Error("MP response requires safe non-negative cursors");
    // Cursor zero is the reference server's bootstrap position; its first event is sequence one.
    if (page.retention_floor > Math.max(page.cursor, 1))
      throw new Error("MP cursor is below the retention floor; no cursor reset performed");
    if (!Array.isArray(page.observations) || page.observations.length > 1)
      throw new Error("MP must return at most one observation");
    if (!page.observations.length) return null;
    const raw: unknown = page.observations[0];
    if (!object(raw) || !nonempty(raw.source) || !nonempty(raw.id))
      throw new Error("MP observation requires nonempty string source and id");
    if (typeof raw.sequence !== "string" || !/^[0-9]{20}$/.test(raw.sequence))
      throw new Error("MP observation requires the 20 digit sequence");
    const seq = Number(raw.sequence);
    if (!cursor(seq) || !cursor(seq + 1) || page.next !== seq + 1 || seq < page.cursor || seq > page.head)
      throw new Error("MP next cursor does not match the delivered observation");
    if (schemas.validate("observation", raw).length)
      throw new Error("MP observation does not conform to the observation schema");
    const event = { ...raw } as unknown as Observation;
    delete event.redelivered; // Delivery metadata must not change the event fingerprint.
    return { event, next: page.next };
  }

  async acknowledge(next: number): Promise<void> {
    if (!cursor(next)) throw new Error("MP acknowledgement requires a safe non-negative cursor");
    const result = await this.request("ack", { cursor: next });
    if (!cursor(result.cursor) || result.cursor !== next)
      throw new Error("MP acknowledgement did not commit the requested cursor");
  }
}
