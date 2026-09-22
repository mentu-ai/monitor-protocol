/**
 * REST + JSON-RPC + SSE door (spec/02-methods.md §REST binding). All semantics live in
 * MonitorService; this file only maps HTTP onto it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { FILTER_KEYS } from "../filter.js";
import type { Filter, Result } from "../types.js";
import { JSONRPC_OF, type ErrorCode } from "../vocab.js";
import { err, MonitorService } from "./core.js";

export const BASE_PATH = "/mp/v0";
const LIST_KEYS = new Set(["types", "sources", "subjects", "actors", "tiers", "origins", "horizons"]);
/** Heartbeat cadence of the SSE stream; also how fast it notices a client that went away. */
const STREAM_POLL_SECONDS = 5;

export interface HttpOptions { allowAdmin?: boolean; log?: (line: string) => void }

const json = (res: ServerResponse, r: Result): void => {
  const body = JSON.stringify(r.body);
  res.writeHead(r.status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store", ...(r.headers ?? {}) });
  res.end(body);
};

const bearerOf = (req: IncomingMessage): string | null => {
  const h = req.headers.authorization ?? "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : null;
};

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
}

/** Query params that are filter keys become the inline filter; `cursor`, `wait` and `limit` are pull params. */
export function filterFromQuery(sp: URLSearchParams): Filter {
  const f: Record<string, unknown> = {};
  for (const key of new Set(sp.keys())) {
    if (key === "cursor" || key === "wait" || key === "limit") continue;
    const isTag = key.startsWith("#");
    if (!isTag && !FILTER_KEYS.has(key)) { f[key] = sp.getAll(key); continue; }   // kept so validateFilter refuses it by name
    const values = sp.getAll(key).flatMap(v => v.includes(",") ? v.split(",") : [v]).map(v => v.trim()).filter(Boolean);
    if (isTag || LIST_KEYS.has(key)) f[key] = values;
    else if (key === "since" || key === "until" || key === "text") f[key] = values[0];
    else f[key] = values[0];
  }
  return f as Filter;
}

const RPC_METHODS: Record<string, string> = {
  "monitors/discover": "discover", "monitors/list": "list", "monitors/get": "get", "monitors/create": "create",
  "monitors/update": "update", "monitors/pause": "pause", "monitors/resume": "resume", "monitors/retire": "retire",
  "monitors/state": "state", "monitors/publish": "publish",
  "feeds/subscribe": "subscribe", "feeds/pull": "pull", "feeds/ack": "ack", "feeds/seek": "seek",
  "feeds/renew": "renew", "feeds/retire": "sub-retire",
  "leases/claim": "claim", "leases/renew": "lease-renew", "leases/complete": "complete",
  "leases/release": "release", "leases/reject": "reject",
};

export function createHttpServer(service: MonitorService, opts: HttpOptions = {}): Server {
  const dispatchRpc = async (method: string, params: Record<string, unknown>, headerBearer: string | null): Promise<Result> => {
    const meta = (params._meta ?? {}) as Record<string, unknown>;
    const auth = { bearer: headerBearer ?? (meta["ai.mentu/bearer"] as string | undefined) ?? (params.bearer as string | undefined) ?? null };
    const op = RPC_METHODS[method];
    const id = String(params.id ?? params.monitor ?? "");
    const sid = String(params.subscription ?? params.id ?? "");
    switch (op) {
      case "discover": return service.discover();
      case "list": return service.listMonitors(auth);
      case "get": return service.getMonitor(id, auth);
      case "create": return service.createMonitor(params);
      case "state": return service.state(id, auth);
      case "update": case "pause": case "resume": case "retire": case "publish":
        return service.monitorAction(id, op === "publish" ? "observations" : op, params, auth);
      case "subscribe": return service.subscribe(params, auth);
      case "pull": return await service.pull(sid, { cursor: params.cursor as number | undefined, wait: params.wait as number | undefined, limit: params.limit as number | undefined, filter: params.filter as Filter | undefined }, auth);
      case "ack": case "seek": case "renew": return service.subAction(sid, op, params, auth);
      case "sub-retire": return service.subAction(sid, "retire", params, auth);
      case "claim": case "complete": case "release": case "reject": return service.leaseAction(sid, op, params, auth);
      case "lease-renew": return service.leaseAction(sid, "renew", params, auth);
      default: return err("NOT_FOUND", `unknown method ${method}`);
    }
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      if (!path.startsWith(BASE_PATH)) return json(res, err("NOT_FOUND", "unknown route; the protocol is served under /mp/v0"));
      service.sweep();
      const p = path.slice(BASE_PATH.length) || "/";
      const auth = { bearer: bearerOf(req) };
      const method = req.method ?? "GET";
      opts.log?.(`${method} ${p}`);

      if (method === "GET") {
        if (p === "/discover") return json(res, service.discover());
        if (p === "/monitors") return json(res, service.listMonitors(auth));
        if (p === "/admin/snapshot" && opts.allowAdmin) return json(res, { status: 200, body: service.store.snapshot() });
        let m = /^\/monitors\/([\w.-]+)$/.exec(p);
        if (m) return json(res, service.getMonitor(m[1], auth));
        m = /^\/monitors\/([\w.-]+)\/state$/.exec(p);
        if (m) return json(res, service.state(m[1], auth));
        m = /^\/subscriptions\/([\w.-]+)\/pull$/.exec(p);
        if (m) {
          const q = url.searchParams;
          const r = await service.pull(m[1], {
            cursor: q.has("cursor") ? Number(q.get("cursor")) : undefined,
            wait: q.has("wait") ? Number(q.get("wait")) : undefined,
            limit: q.has("limit") ? Number(q.get("limit")) : undefined,
            filter: filterFromQuery(q),
          }, auth);
          return json(res, r);
        }
        m = /^\/subscriptions\/([\w.-]+)\/stream$/.exec(p);
        if (m) return await stream(service, req, res, m[1], url, auth);
        return json(res, err("NOT_FOUND", "unknown route"));
      }

      if (method === "POST") {
        const body = await readBody(req);
        if (body === null) return json(res, err("INVALID", "body is not valid JSON"));
        if (p === "/rpc") {
          const batch = Array.isArray(body) ? (body as unknown as Record<string, unknown>[]) : [body];
          const out = [];
          for (const call of batch) {
            const r = await dispatchRpc(String(call.method ?? ""), (call.params as Record<string, unknown>) ?? {}, auth.bearer);
            const rid = call.id ?? null;
            if (r.status >= 400) {
              const code = (r.body as { code?: ErrorCode }).code ?? "INVALID";
              out.push({ jsonrpc: "2.0", id: rid, error: { code: JSONRPC_OF[code] ?? -32003, message: (r.body as { error?: string }).error ?? "error", data: r.body } });
            } else out.push({ jsonrpc: "2.0", id: rid, result: r.body });
          }
          return json(res, { status: 200, body: Array.isArray(body) ? out : out[0] });
        }
        if (p === "/monitors") return json(res, service.createMonitor(body, body.owner as string | undefined));
        if (p === "/subscriptions") return json(res, service.subscribe(body, auth));
        if (p === "/admin/compact" && opts.allowAdmin) {
          const n = service.store.compact(Number(body.upto_seq ?? 0));
          return json(res, { status: 200, body: { compacted: n, retention_floor: service.store.retentionFloor() } });
        }
        let m = /^\/monitors\/([\w.-]+)\/(update|pause|resume|retire|observations)$/.exec(p);
        if (m) return json(res, service.monitorAction(m[1], m[2], body, auth));
        m = /^\/subscriptions\/([\w.-]+)\/(ack|seek|renew|retire)$/.exec(p);
        if (m) return json(res, service.subAction(m[1], m[2], body, auth));
        m = /^\/subscriptions\/([\w.-]+)\/leases\/(claim|renew|complete|release|reject)$/.exec(p);
        if (m) return json(res, service.leaseAction(m[1], m[2], body, auth));
        return json(res, err("NOT_FOUND", "unknown route"));
      }
      return json(res, err("NOT_FOUND", `unsupported method ${method}`));
    } catch (e) {
      json(res, { status: 500, body: { code: "INVALID", error: `${(e as Error).name}: ${(e as Error).message}` } });
    }
  });
}

/** SSE delivery (spec/03-bindings.md). `Last-Event-ID` resumes the stream; only ack commits. */
async function stream(service: MonitorService, req: IncomingMessage, res: ServerResponse, sid: string, url: URL, auth: { bearer: string | null }): Promise<void> {
  const probe = await service.pull(sid, { limit: 1, wait: 0 }, auth);
  if (probe.status >= 400) return json(res, probe);
  const last = req.headers["last-event-id"];
  const fromHeader = Array.isArray(last) ? last[0] : last;
  let cursor = fromHeader != null ? Number(fromHeader) : url.searchParams.has("cursor") ? Number(url.searchParams.get("cursor")) : (probe.body as { cursor: number }).cursor;
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write("retry: 3000\n\n");
  // The client-gone signal is the response closing. A bodyless GET's IncomingMessage emits
  // "close" as soon as it is consumed, which would end the stream after its first batch.
  let open = true;
  res.on("close", () => { open = false; });
  while (open && !res.writableEnded) {
    const r = await service.pull(sid, { cursor, wait: STREAM_POLL_SECONDS, limit: 100 }, auth);
    if (r.status >= 400) { res.write(`event: error\ndata: ${JSON.stringify(r.body)}\n\n`); break; }
    const page = r.body as { observations: { id: string }[]; next: number; head: number };
    for (const o of page.observations) { res.write(`id: ${o.id}\nevent: observation\ndata: ${JSON.stringify(o)}\n\n`); cursor = Number(o.id); }
    if (!page.observations.length) res.write(`event: heartbeat\ndata: ${JSON.stringify({ head: page.head, cursor })}\n\n`);
  }
  if (!res.writableEnded) res.end();
}

export async function listen(server: Server, port = 0, host = "127.0.0.1"): Promise<{ port: number; url: string; close(): Promise<void> }> {
  await new Promise<void>(resolve => server.listen(port, host, resolve));
  const addr = server.address();
  const bound = typeof addr === "object" && addr ? addr.port : port;
  return { port: bound, url: `http://${host}:${bound}`, close: () => new Promise<void>(r => server.close(() => r())) };
}
