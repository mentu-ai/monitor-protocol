/** Thin HTTP client for the REST binding. Returns {status, body}; throws only on network failure. */
import { BASE_PATH } from "./server/http.js";
import type { Filter } from "./types.js";

export interface ClientResult<T = unknown> { status: number; body: T }

export class MonitorClient {
  private readonly f: typeof fetch;
  constructor(readonly base: string, opts: { fetch?: typeof fetch } = {}) {
    this.base = base.replace(/\/$/, "");
    this.f = opts.fetch ?? fetch;
  }
  private url(path: string, query?: Record<string, unknown>): string {
    const u = new URL(this.base + BASE_PATH + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v == null) continue;
      if (Array.isArray(v)) for (const x of v) u.searchParams.append(k, String(x));
      else u.searchParams.set(k, String(v));
    }
    return u.toString();
  }
  private async call<T>(method: string, path: string, opts: { body?: unknown; token?: string | null; query?: Record<string, unknown> } = {}): Promise<ClientResult<T>> {
    const res = await this.f(this.url(path, opts.query), {
      method,
      headers: { "Content-Type": "application/json", ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    let body: unknown;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { code: "INVALID", error: "response is not JSON", raw: text.slice(0, 200) }; }
    return { status: res.status, body: body as T };
  }
  private flatten(q?: { cursor?: number; wait?: number; limit?: number; filter?: Filter }): Record<string, unknown> {
    const out: Record<string, unknown> = { cursor: q?.cursor, wait: q?.wait, limit: q?.limit };
    for (const [k, v] of Object.entries(q?.filter ?? {})) out[k] = v;
    return out;
  }
  discover<T = unknown>() { return this.call<T>("GET", "/discover"); }
  listMonitors<T = unknown>(token?: string | null) { return this.call<T>("GET", "/monitors", { token }); }
  createMonitor<T = unknown>(body: unknown) { return this.call<T>("POST", "/monitors", { body }); }
  monitor<T = unknown>(id: string, token?: string | null) { return this.call<T>("GET", `/monitors/${id}`, { token }); }
  state<T = unknown>(id: string, token?: string | null) { return this.call<T>("GET", `/monitors/${id}/state`, { token }); }
  configure<T = unknown>(id: string, action: "update" | "pause" | "resume" | "retire", ownerToken: string, body: unknown = {}) {
    return this.call<T>("POST", `/monitors/${id}/${action}`, { body, token: ownerToken });
  }
  publish<T = unknown>(id: string, ownerToken: string, body: unknown) { return this.call<T>("POST", `/monitors/${id}/observations`, { body, token: ownerToken }); }
  subscribe<T = unknown>(body: unknown, token?: string | null) { return this.call<T>("POST", "/subscriptions", { body, token }); }
  pull<T = unknown>(sid: string, token: string, q?: { cursor?: number; wait?: number; limit?: number; filter?: Filter }) {
    return this.call<T>("GET", `/subscriptions/${sid}/pull`, { token, query: this.flatten(q) });
  }
  ack<T = unknown>(sid: string, token: string, cursor: number) { return this.call<T>("POST", `/subscriptions/${sid}/ack`, { body: { cursor }, token }); }
  seek<T = unknown>(sid: string, token: string, cursor: number, reason: string) { return this.call<T>("POST", `/subscriptions/${sid}/seek`, { body: { cursor, reason }, token }); }
  renewSubscription<T = unknown>(sid: string, token: string) { return this.call<T>("POST", `/subscriptions/${sid}/renew`, { body: {}, token }); }
  retireSubscription<T = unknown>(sid: string, token: string, reason?: string) { return this.call<T>("POST", `/subscriptions/${sid}/retire`, { body: { reason }, token }); }
  lease<T = unknown>(sid: string, token: string, action: "claim" | "renew" | "complete" | "release" | "reject", body: unknown) {
    return this.call<T>("POST", `/subscriptions/${sid}/leases/${action}`, { body, token });
  }
  rpc<T = unknown>(calls: unknown, token?: string | null) { return this.call<T>("POST", "/rpc", { body: calls, token }); }
}
