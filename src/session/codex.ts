/** Deliver to an already human-opened Codex terminal. This adapter never starts a session. */
import { basename, isAbsolute } from "node:path";
import { canonicalUuid, inspectProcess, processRuntime, terminal, type ProcessRuntime, type SessionProcess } from "./process.js";

export type CodexProcess = SessionProcess;

/** Store privately with the consumer's state. This is a binding, not a credential. */
export interface CodexBinding {
  provider: "codex";
  version: 1;
  platform: "darwin" | "linux";
  thread: string;
  process: CodexProcess;
  executable: string;
}

/** Injectable OS boundary for tests and embedders. Production uses execFile, never a shell. */
export interface CodexRuntime extends ProcessRuntime {
  threadId: string | undefined;
}

export class CodexSessionError extends Error {
  constructor(public readonly code: "UNSUPPORTED_PLATFORM" | "INVALID_THREAD" | "NO_LIVE_SESSION" |
    "QUEUE_UNAVAILABLE" | "STALE_SESSION" | "ENQUEUE_UNCERTAIN", message: string) {
    super(message);
    this.name = "CodexSessionError";
  }
}

/** Retrying may duplicate enqueue; keep the same delivery ID and require a handling receipt. */
export class CodexQueueRetryError extends CodexSessionError {
  constructor() {
    super("ENQUEUE_UNCERTAIN", "Codex enqueue failed or is uncertain; retain the delivery for retry");
    this.name = "CodexQueueRetryError";
  }
}

function runtime(overrides: Partial<CodexRuntime>): CodexRuntime {
  return { ...processRuntime(), threadId: process.env.CODEX_THREAD_ID, ...overrides };
}

async function processExecutable(row: CodexProcess, os: CodexRuntime): Promise<string> {
  // Linux ps comm is only a name. /proc gives the executable of this precise process;
  // macOS ps comm gives its path. Never resolve a possibly older installation from PATH.
  const path = os.platform === "linux" ? await os.readlink(`/proc/${row.pid}/exe`) : row.command;
  if (!isAbsolute(path) || basename(path) !== "codex") throw new Error("native Codex executable unavailable");
  const resolved = await os.realpath(path);
  await os.checkExecutable(resolved);
  return resolved;
}

function validBinding(binding: CodexBinding, os: CodexRuntime): boolean {
  const row = binding?.process;
  return binding?.provider === "codex" && binding.version === 1 &&
    (binding.platform === "darwin" || binding.platform === "linux") && binding.platform === os.platform &&
    typeof binding.thread === "string" && canonicalUuid.test(binding.thread) &&
    typeof binding.executable === "string" && isAbsolute(binding.executable) && !!row &&
    Number.isSafeInteger(row.pid) && row.pid > 1 && Number.isSafeInteger(row.parent) && row.parent >= 1 &&
    typeof row.started === "string" && !!row.started && typeof row.tty === "string" && terminal(row.tty) &&
    typeof row.command === "string" && basename(row.command) === "codex";
}

async function isLive(binding: CodexBinding, os: CodexRuntime): Promise<boolean> {
  if (!validBinding(binding, os)) return false;
  const row = await inspectProcess(binding.process.pid, os);
  if (!row || row.parent !== binding.process.parent || row.started !== binding.process.started ||
    row.tty !== binding.process.tty || row.command !== binding.process.command) return false;
  try { return await processExecutable(row, os) === binding.executable; }
  catch { return false; }
}

/** Bind only the calling terminal's native Codex ancestor and declared thread. */
export async function bindCodexSession(overrides: Partial<CodexRuntime> = {}): Promise<CodexBinding> {
  const os = runtime(overrides);
  if (os.platform !== "darwin" && os.platform !== "linux") {
    throw new CodexSessionError("UNSUPPORTED_PLATFORM", "Codex live-session binding supports macOS and Linux only");
  }
  if (!os.threadId || !canonicalUuid.test(os.threadId)) {
    throw new CodexSessionError("INVALID_THREAD", "Run inside the target Codex terminal: CODEX_THREAD_ID must be a canonical UUID");
  }
  let pid = os.pid;
  const seen = new Set<number>();
  while (pid > 1 && !seen.has(pid) && seen.size < 128) {
    seen.add(pid);
    const row = await inspectProcess(pid, os);
    if (!row) break;
    if (basename(row.command) === "codex") {
      // A headless nearest Codex ancestor must not fall through to an outer terminal session.
      if (!terminal(row.tty)) break;
      let executable: string;
      try {
        executable = await processExecutable(row, os);
        const help = await os.run(executable, ["queue", "--help"]);
        if (!/(?:^|\s)--thread(?:\s|=|$)/.test(help) || !/(?:^|\s)--message(?:\s|=|$)/.test(help)) {
          throw new Error("queue flags unavailable");
        }
      } catch {
        throw new CodexSessionError("QUEUE_UNAVAILABLE", "The live Codex executable must support queue --thread and --message");
      }
      const binding: CodexBinding = {
        provider: "codex", version: 1, platform: os.platform,
        thread: os.threadId, process: row, executable,
      };
      if (!await isLive(binding, os)) throw new CodexSessionError("STALE_SESSION", "Codex session changed during binding");
      return binding;
    }
    pid = row.parent;
  }
  throw new CodexSessionError("NO_LIVE_SESSION", "No live Codex terminal ancestor; tools hosted in a separate app server need an attended frontend binding that this adapter does not yet support");
}

/** A stale binding is never repaired by opening or resuming a model session. */
export async function isCodexSessionLive(binding: CodexBinding, overrides: Partial<CodexRuntime> = {}): Promise<boolean> {
  return isLive(binding, runtime(overrides));
}

/** Queue acceptance is not an acknowledgement of handling; the consumer owns that receipt. */
export async function enqueueCodex(binding: CodexBinding, message: string, overrides: Partial<CodexRuntime> = {}): Promise<void> {
  const os = runtime(overrides);
  if (!await isLive(binding, os)) throw new CodexSessionError("STALE_SESSION", "Codex session binding is stale; stop delivery");
  if (typeof message !== "string" || !message || message.includes("\0") || Buffer.byteLength(message, "utf8") > 32 * 1024) {
    throw new TypeError("Codex notification must be nonempty text of at most 32 KiB without NUL bytes");
  }
  try {
    await os.run(binding.executable, ["queue", "--thread", binding.thread, "--message", message]);
  } catch {
    // A timeout can happen after durable enqueue. The consumer must retain the same delivery
    // identity on retry, and must never interpret command failure or success as event handling.
    if (!await isLive(binding, os)) throw new CodexSessionError("STALE_SESSION", "Codex session ended during enqueue; stop delivery");
    throw new CodexQueueRetryError();
  }
}
