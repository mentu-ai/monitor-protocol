/**
 * MCP door (spec/03-bindings.md §"MCP extension"). Tools and `monitor://` resources over the
 * installed SDK's low-level Server, so the surface stays plain JSON Schema and can be inspected
 * without starting anything. Wake-ups are best effort: delivery is monitor_pull + monitor_ack.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema, ListResourceTemplatesRequestSchema, ListResourcesRequestSchema,
  ListToolsRequestSchema, ReadResourceRequestSchema, SubscribeRequestSchema, UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Filter, Result } from "../types.js";
import { CAPABILITIES, EXTENSION_ID, HORIZONS, ORIGINS, PROTOCOL_VERSION, TIERS, VERIFICATIONS, VISIBILITIES } from "../vocab.js";
import type { MonitorService } from "./core.js";

const S = {
  bearer: { type: "string", description: "Bearer token. Owner token for a monitor, subscription token for a feed or lease." },
  id: { type: "string", description: "Monitor id." },
  subscription: { type: "string", description: "Subscription id." },
  filter: { type: "object", description: "Nostr-shaped filter: AND across keys, OR within arrays. Keys: types, sources, subjects, actors, tiers, origins, horizons, since, until, limit, text, #tag." },
} as const;
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: true });

/** The static model-facing surface; `monitor-protocol tools --json` prints this without starting a server. */
export const MCP_TOOL_DEFINITIONS: { name: string; description: string; inputSchema: Record<string, unknown> }[] = [
  { name: "monitor_discover", description: "Protocol version, capabilities, limits and server identity.", inputSchema: obj({}) },
  { name: "monitor_list", description: "List monitors visible to you; private ones need their owner token.", inputSchema: obj({ bearer: S.bearer }) },
  { name: "monitor_get", description: "One monitor definition.", inputSchema: obj({ id: S.id, bearer: S.bearer }, ["id"]) },
  { name: "monitor_create", description: "Create a monitor. The reply carries the owner token once; keep it, it is never shown again.",
    inputSchema: obj({ id: { type: "string" }, name: { type: "string" }, description: { type: "string" },
      owner: { type: "string", description: "Actor URI: human:… agent:… system:… hook:…" },
      source: obj({ kind: { type: "string", enum: ["shell", "ws", "http", "file", "feed", "cir", "formula", "log"] }, ref: { type: "string" } }, ["kind"]),
      horizon: { type: "string", enum: [...HORIZONS], description: "Authority scale: a faster horizon never writes what a slower one owns." },
      capabilities: { type: "array", items: { type: "string", enum: [...CAPABILITIES] } },
      visibility: { type: "string", enum: [...VISIBILITIES] }, filter: S.filter,
      types: { type: "array", items: { type: "string" }, description: "Reverse-DNS observation types this monitor declares." },
      cadence: { type: "object" }, ttl_seconds: { type: "integer" }, retire_after_mute_seconds: { type: "integer" }, rules: { type: "array" } },
      ["name", "horizon", "capabilities"]) },
  { name: "monitor_configure", description: "Update, pause, resume or retire a monitor. The change is itself an observation with its reason.",
    inputSchema: obj({ id: S.id, action: { type: "string", enum: ["update", "pause", "resume", "retire"] }, patch: { type: "object" }, reason: { type: "string" }, rule: { type: "string" }, bearer: S.bearer }, ["id", "action", "bearer"]) },
  { name: "monitor_publish", description: "Publish one observation. An agent may not assert tier 'src'; a refusal is itself a recorded observation.",
    inputSchema: obj({ id: S.id, bearer: S.bearer, type: { type: "string", description: "Reverse-DNS observation type." }, subject: { type: "string" },
      data: { type: "object" }, tier: { type: "string", enum: [...TIERS] }, origin: { type: "string", enum: [...ORIGINS] },
      verification: { type: "string", enum: [...VERIFICATIONS] }, actor: { type: "string" },
      supersedes: obj({ source: { type: "string" }, id: { type: "string" } }, ["source", "id"]) }, ["id", "bearer", "type"]) },
  { name: "monitor_state", description: "The computed state: counters, ages, contradictions and a confidence that names its missing inputs.", inputSchema: obj({ id: S.id, bearer: S.bearer }, ["id"]) },
  { name: "monitor_subscribe", description: "Create or renew a subscription with a durable cursor. The reply carries the token once.",
    inputSchema: obj({ monitor: { type: "string" }, subscriber: { type: "string", description: "Actor URI, e.g. agent:claude@ab12cd34." },
      capabilities: { type: "array", items: { type: "string", enum: [...CAPABILITIES] } }, filter: S.filter,
      from: { description: "'head', or an integer cursor to start after.", anyOf: [{ type: "string" }, { type: "integer" }] },
      protocol: { type: "string", enum: ["pull", "http", "mcp"] }, reset_policy: { type: "string", enum: ["earliest", "latest", "none"] },
      retire_after_mute_seconds: { type: "integer" }, bearer: S.bearer }, ["monitor", "subscriber"]) },
  { name: "monitor_pull", description: "Read observations after the cursor. Does not advance it; call monitor_ack after processing.",
    inputSchema: obj({ subscription: S.subscription, bearer: S.bearer, cursor: { type: "integer", description: "Read-only replay from this seq." }, wait: { type: "integer", description: "Long-poll seconds, capped at 25." }, limit: { type: "integer" }, filter: S.filter }, ["subscription", "bearer"]) },
  { name: "monitor_ack", description: "Commit the cursor after processing. Cumulative; it never moves backwards.", inputSchema: obj({ subscription: S.subscription, bearer: S.bearer, cursor: { type: "integer" } }, ["subscription", "bearer", "cursor"]) },
  { name: "lease_claim", description: "Take an exclusive time-limited lease on one subject. One holder wins; the rest are told who holds it.",
    inputSchema: obj({ subscription: S.subscription, bearer: S.bearer, subject: { type: "string" }, lease_duration_seconds: { type: "integer" }, note: { type: "string" } }, ["subscription", "bearer", "subject"]) },
  { name: "lease_complete", description: "Finish the work and release the lease, citing the evidence.",
    inputSchema: obj({ subscription: S.subscription, bearer: S.bearer, subject: { type: "string" }, outcome: { type: "string" }, evidence: { type: "array" }, note: { type: "string" } }, ["subscription", "bearer", "subject"]) },
  { name: "lease_release", description: "Return the subject to the queue without completing it, with a reason.",
    inputSchema: obj({ subscription: S.subscription, bearer: S.bearer, subject: { type: "string" }, reason: { type: "string" } }, ["subscription", "bearer", "subject"]) },
];

const text = (r: Result) => ({ content: [{ type: "text" as const, text: JSON.stringify(r.body, null, 1) }], structuredContent: r.body as Record<string, unknown>, isError: r.status >= 400 });

export function createMcpServer(service: MonitorService, opts: { serverName?: string } = {}): {
  server: Server; connect(transport: Transport): Promise<void>; notifyState(monitorId: string): void;
} {
  const server = new Server(
    { name: opts.serverName ?? "monitor-protocol", version: PROTOCOL_VERSION },
    // The installed SDK's ServerCapabilities has no `extensions` field, so the extension id
    // travels under `experimental` (spec/03-bindings.md records the intended name).
    { capabilities: { tools: { listChanged: false }, resources: { subscribe: true, listChanged: true }, experimental: { [EXTENSION_ID]: { version: PROTOCOL_VERSION } } } },
  );

  const subscribed = new Set<string>();
  const pending = new Map<string, NodeJS.Timeout>();

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: MCP_TOOL_DEFINITIONS }));

  server.setRequestHandler(CallToolRequestSchema, async req => {
    const a = (req.params.arguments ?? {}) as Record<string, unknown>;
    const auth = { bearer: (a.bearer as string | undefined) ?? null };
    const id = String(a.id ?? "");
    const sid = String(a.subscription ?? "");
    switch (req.params.name) {
      case "monitor_discover": return text(service.discover());
      case "monitor_list": return text(service.listMonitors(auth));
      case "monitor_get": return text(service.getMonitor(id, auth));
      case "monitor_create": return text(service.createMonitor(a));
      case "monitor_configure": return text(service.monitorAction(id, String(a.action ?? ""), a, auth));
      case "monitor_publish": return text(service.monitorAction(id, "observations", a, auth));
      case "monitor_state": return text(service.state(id, auth));
      case "monitor_subscribe": return text(service.subscribe(a, auth));
      case "monitor_pull": return text(await service.pull(sid, { cursor: a.cursor as number | undefined, wait: Math.min(25, Number(a.wait ?? 0)), limit: a.limit as number | undefined, filter: a.filter as Filter | undefined }, auth));
      case "monitor_ack": return text(service.subAction(sid, "ack", a, auth));
      case "lease_claim": return text(service.leaseAction(sid, "claim", a, auth));
      case "lease_complete": return text(service.leaseAction(sid, "complete", a, auth));
      case "lease_release": return text(service.leaseAction(sid, "release", a, auth));
      default: return { content: [{ type: "text" as const, text: `unknown tool ${req.params.name}` }], isError: true };
    }
  });

  const visible = () => [...service.store.monitors.values()].filter(m => m.visibility !== "private");
  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: visible().flatMap(m => [
      { uri: `monitor://${m.id}/definition`, name: `${m.name} — definition`, mimeType: "application/json" },
      { uri: `monitor://${m.id}/state`, name: `${m.name} — state`, mimeType: "application/json" },
    ]),
  }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
    resourceTemplates: [
      { uriTemplate: "monitor://{id}/definition", name: "Monitor definition", mimeType: "application/json" },
      { uriTemplate: "monitor://{id}/state", name: "Monitor state", mimeType: "application/json" },
    ],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, req => {
    const m = /^monitor:\/\/([\w.-]+)\/(definition|state)$/.exec(req.params.uri);
    if (!m) throw new Error(`unknown resource ${req.params.uri}`);
    const r = m[2] === "state" ? service.state(m[1], { bearer: null }) : service.getMonitor(m[1], { bearer: null });
    if (r.status >= 400) throw new Error(JSON.stringify(r.body));
    return { contents: [{ uri: req.params.uri, mimeType: "application/json", text: JSON.stringify(r.body, null, 1) }] };
  });
  server.setRequestHandler(SubscribeRequestSchema, req => { subscribed.add(req.params.uri); return {}; });
  server.setRequestHandler(UnsubscribeRequestSchema, req => { subscribed.delete(req.params.uri); return {}; });

  const notifyState = (monitorId: string): void => {
    const uri = `monitor://${monitorId}/state`;
    if (!subscribed.has(uri) || pending.has(monitorId)) return;
    const t = setTimeout(() => {
      pending.delete(monitorId);
      void server.sendResourceUpdated({ uri }).catch(() => undefined);
    }, 250);
    t.unref?.();
    pending.set(monitorId, t);
  };
  service.store.on("append", (ev: { monitor: string }) => notifyState(ev.monitor));

  return { server, connect: (t: Transport) => server.connect(t), notifyState };
}

export async function serveMcp(service: MonitorService): Promise<void> {
  const { connect } = createMcpServer(service);
  await connect(new StdioServerTransport());
}
