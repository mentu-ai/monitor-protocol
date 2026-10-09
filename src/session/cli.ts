import { fileURLToPath } from "node:url";
import { BridgeJournal, SessionBridge, canonical, runSessionBridge, type BridgeHeader } from "./bridge.js";
import { bindCodexSession, enqueueCodex, isCodexSessionLive, CodexQueueRetryError, type CodexBinding } from "./codex.js";
import { BridgeRetryError, HttpSubscriptionSource } from "./source.js";
import { expandHome } from "../paths.js";

export const BRIDGE_USAGE = `monitor-protocol bridge:
  run --base URL --subscription ID --token-env NAME --state DIR [--adapter codex] [--poll-ms 1000]
      Bind the calling live Codex terminal session; deliver metadata via its native queue.
      The subscription must already exist. The bearer stays in the environment.
  show --state DIR --delivery ID
      Read the untrusted observation in the same bound live session.
  handled --state DIR --delivery ID --evidence DISPOSITION_OR_REFERENCE
      Record a local handling receipt. The worker then acknowledges the source.
  status --state DIR
      Report session liveness separately from worker identity, heartbeat, and exit status.
  stop --state DIR
      Stop delivery permanently for this binding. It never retires the subscription.
  --help
Requires a private state directory (0700), an existing human-opened terminal session,
and a native Codex executable that supports queue --thread / --message. Never starts a session.`;

function flags(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const equals = arg.indexOf("=");
    const key = arg.slice(2, equals < 0 ? undefined : equals);
    const value = equals < 0 ? argv[++i] : arg.slice(equals + 1);
    if (!value || value.startsWith("--") || Object.hasOwn(result, key)) throw new Error(`expected one value for --${key}`);
    result[key] = value;
  }
  return result;
}

export async function bridgeMain(argv: string[]): Promise<number> {
  if (!argv.length || argv.includes("--help")) { console.log(BRIDGE_USAGE); return 0; }
  const [action, ...rest] = argv;
  const options: Record<string, string[]> = {
    run: ["state", "base", "subscription", "token-env", "adapter", "poll-ms"],
    show: ["state", "delivery"], handled: ["state", "delivery", "evidence"],
    status: ["state"], stop: ["state"],
  };
  if (!Object.hasOwn(options, action)) throw new Error(`unknown bridge action: ${action}`);
  const f = flags(rest);
  for (const key of Object.keys(f)) if (!options[action].includes(key)) throw new Error(`unknown option --${key}`);
  const required = (key: string) => { if (!f[key]) throw new Error(`bridge ${action} needs --${key}`); return f[key]; };
  const path = expandHome(required("state"));
  if (action === "run") {
    if (f.adapter && f.adapter !== "codex") throw new Error("this release supplies the codex adapter; other harnesses use watch/pull or implement SessionAdapter");
    const poll = f["poll-ms"] === undefined ? 1000 : Number(f["poll-ms"]);
    if (!Number.isSafeInteger(poll) || poll < 100 || poll > 30_000) throw new Error("--poll-ms must be an integer from 100 to 30000");
    const tokenName = required("token-env");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenName) || !process.env[tokenName]) throw new Error("--token-env must name an environment variable containing the existing subscription bearer");
    const source = new HttpSubscriptionSource(required("base"), required("subscription"), process.env[tokenName]!);
    const binding = await bindCodexSession();
    const header: BridgeHeader = { version: 1, adapter: "codex", binding,
      source: { base: source.base, subscription: source.subscription } };
    const journal = new BridgeJournal(path, header);
    if (journal.stopped()) throw new Error("this bridge was stopped; use a new state directory to explicitly rearm");
    const worker = new SessionBridge(journal, source, {
      kind: "codex", binding, isLive: () => isCodexSessionLive(binding),
      enqueue: message => enqueueCodex(binding, message),
    }, [process.execPath, fileURLToPath(new URL("../index.js", import.meta.url))]);
    return runSessionBridge(worker, {
      pollMs: poll,
      isRetryable: error => error instanceof BridgeRetryError || error instanceof CodexQueueRetryError,
      onStatus: status => {
        if (status === "bound") console.log(JSON.stringify({ status, state: journal.path, adapter: "codex", subscription: source.subscription }));
        else if (status === "retrying") console.error("bridge transport unavailable or enqueue uncertain; retaining delivery and cursor, retrying");
        else console.log(JSON.stringify({ status }));
      },
    });
  }
  const journal = new BridgeJournal(path);
  if (action === "stop") { journal.stop(); console.log(JSON.stringify({ status: "stopped" })); return 0; }
  const saved = journal.header();
  if (saved.adapter !== "codex") throw new Error("unsupported saved session adapter");
  if (action === "status") {
    const [live, worker] = await Promise.all([
      isCodexSessionLive(saved.binding as CodexBinding), journal.workerStatus(),
    ]);
    const item = journal.pending();
    console.log(JSON.stringify({ stopped: journal.stopped(), live, session_alive: live,
      worker_alive: worker.alive, active: !journal.stopped() && live && worker.healthy, worker, adapter: saved.adapter,
      subscription: saved.source.subscription, delivery: item?.id ?? null,
      phase: item ? journal.receipt(item.id) ? "handled" : journal.queued(item.id) ? "queued" : "pending" : "idle" }));
    return 0;
  }
  // An environment variable alone is not a session identity: discover the actual calling ancestor.
  const current = await bindCodexSession();
  if (journal.stopped() || canonical(saved.binding) !== canonical(current) || !await isCodexSessionLive(current))
    throw new Error("stale or different session binding; observation not attended or acknowledged");
  const item = journal.get(required("delivery"));
  if (action === "show") {
    console.log(JSON.stringify({ delivery: item.id, fingerprint: item.fingerprint, untrusted: true,
      acknowledged: journal.acked(item.id), receipt: journal.receipt(item.id), observation: item.event }, null, 2));
  } else {
    console.log(JSON.stringify(journal.handle(item.id, required("evidence"))));
  }
  return 0;
}
