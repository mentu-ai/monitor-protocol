/**
 * CLI and public API for @mentu/monitor-protocol.
 *   serve · mcp · watch · conform · publish · tools
 */
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { MemoryStore } from "./store.js";
import { MonitorService } from "./server/core.js";
import { createHttpServer, listen } from "./server/http.js";
import { MCP_TOOL_DEFINITIONS, serveMcp } from "./server/mcp.js";
import { printSummary, runConformance } from "./conformance.js";
import { watch } from "./watch.js";

export * from "./vocab.js";
export * from "./types.js";
export * from "./filter.js";
export * from "./cloudevents.js";
export { MemoryStore } from "./store.js";
export type { LogEvent, MonitorRow, SubscriptionRow, LeaseRow, Snapshot } from "./store.js";
export { MonitorService, err } from "./server/core.js";
export type { ServiceOptions } from "./server/core.js";
export { createHttpServer, listen, BASE_PATH, filterFromQuery } from "./server/http.js";
export { createMcpServer, serveMcp, MCP_TOOL_DEFINITIONS } from "./server/mcp.js";
export { MonitorClient } from "./client.js";
export { watch } from "./watch.js";
export { runConformance, printSummary, SUITE_VERSION } from "./conformance.js";

const USAGE = `monitor-protocol — an epistemic layer over pub/sub

  serve [--port 8130] [--host 127.0.0.1] [--state <file.json>] [--allow-admin] [--retire-after-mute <seconds>]
        Serve the REST + JSON-RPC + SSE binding under /mp/v0.
  mcp   [--state <file.json>]
        Serve the MCP extension ai.mentu/monitors over stdio.
  watch --base <url> --subscription <id> --token <tok> [--catch-up] [--wait 25] [--limit 50] [--once]
        Pull/ack loop, one line per observation. The client for a Claude Code Monitor arm.
  conform (--self | --base <url>) [--admin] [--json]
        Run the conformance suite C01-C21 against an implementation.
  publish --base <url> --monitor <id> --token <owner> --type <t> [--subject s] [--tier measured] [--origin probe] [--data '{}']
        Publish one observation.
  tools [--json]
        Print the model-facing MCP tool surface without starting anything.
  --help · --version`;

interface Flags { [k: string]: string | boolean }
function parse(argv: string[]): { cmd: string; flags: Flags } {
  const cmd = argv[0]?.startsWith("--") ? "" : (argv[0] ?? "");
  const flags: Flags = {};
  for (let i = cmd ? 1 : 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const nxt = argv[i + 1];
    if (nxt && !nxt.startsWith("--")) { flags[key] = nxt; i++; } else flags[key] = true;
  }
  return { cmd, flags };
}
const str = (f: Flags, k: string, d = ""): string => (typeof f[k] === "string" ? (f[k] as string) : d);
const num = (f: Flags, k: string, d: number): number => (typeof f[k] === "string" ? Number(f[k]) : d);

function makeService(flags: Flags): MonitorService {
  const store = new MemoryStore(typeof flags.state === "string" ? flags.state : undefined);
  const retire = num(flags, "retire-after-mute", 604800);
  return new MonitorService(store, { retireAfterMuteDefault: retire });
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { cmd, flags } = parse(argv);
  if (flags.version) {
    const require = createRequire(import.meta.url);
    console.log((require("../package.json") as { version: string }).version);
    return 0;
  }
  if (!cmd || flags.help || cmd === "help") { console.log(USAGE); return cmd ? 0 : 2; }

  switch (cmd) {
    case "serve": {
      const service = makeService(flags);
      const server = createHttpServer(service, { allowAdmin: flags["allow-admin"] === true });
      const { url } = await listen(server, num(flags, "port", 8130), str(flags, "host", "127.0.0.1"));
      const d = service.discover().body as { supportedVersions: string[]; limits: Record<string, unknown> };
      console.log(`listening ${url}/mp/v0 — protocol ${d.supportedVersions.join(",")}, monitors ${service.store.monitors.size}, head ${service.store.head()}`);
      console.log(`limits ${JSON.stringify(d.limits)}`);
      return await new Promise<number>(() => undefined);
    }
    case "mcp": {
      await serveMcp(makeService(flags));
      return await new Promise<number>(() => undefined);
    }
    case "watch": {
      const base = str(flags, "base"), subscription = str(flags, "subscription"), token = str(flags, "token");
      if (!base || !subscription || !token) { console.error("watch needs --base, --subscription and --token"); return 2; }
      await watch({ base, subscription, token, catchUpFirst: flags["catch-up"] === true, wait: num(flags, "wait", 25), limit: num(flags, "limit", 50), once: flags.once === true });
      return 0;
    }
    case "conform": {
      const json = flags.json === true;
      if (flags.self) {
        const service = makeService({});
        const server = createHttpServer(service, { allowAdmin: true });
        const { url, close } = await listen(server, 0);
        try {
          const r = await runConformance(url, { json, admin: true });
          printSummary(r, json);
          return r.fail ? 1 : 0;
        } finally { await close(); }
      }
      const base = str(flags, "base");
      if (!base) { console.error("conform needs --base <url> or --self"); return 2; }
      const r = await runConformance(base, { json, admin: flags.admin === true });
      printSummary(r, json);
      return r.fail ? 1 : 0;
    }
    case "publish": {
      const { MonitorClient } = await import("./client.js");
      const c = new MonitorClient(str(flags, "base"));
      const data = typeof flags.data === "string" ? (JSON.parse(flags.data) as Record<string, unknown>) : {};
      const r = await c.publish(str(flags, "monitor"), str(flags, "token"), {
        type: str(flags, "type"), subject: typeof flags.subject === "string" ? flags.subject : undefined,
        tier: str(flags, "tier", "measured"), origin: str(flags, "origin", "probe"), data,
      });
      console.log(JSON.stringify(r.body, null, 1));
      return r.status >= 400 ? 1 : 0;
    }
    case "tools": {
      if (flags.json === true) console.log(JSON.stringify({ tools: MCP_TOOL_DEFINITIONS }, null, 1));
      else for (const t of MCP_TOOL_DEFINITIONS) console.log(`${t.name.padEnd(20)} ${t.description}`);
      return 0;
    }
    default:
      console.error(`unknown command ${cmd}\n\n${USAGE}`);
      return 2;
  }
}

/** True only when this file is the process entry point: importing the library must not run the CLI. */
function invokedDirectly(): boolean {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
}

if (invokedDirectly()) {
  main().then(code => { if (code !== 0) process.exitCode = code; }).catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
}
