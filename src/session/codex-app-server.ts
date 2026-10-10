/**
 * Bind a tool process that a Codex App Server hosts, apart from any terminal frontend.
 * It proves three things: the caller descends from a live `codex app-server` process, that
 * process holds the Unix socket the caller's RPC uses, and `thread/read` on that socket
 * reports the declared thread as loaded. It reads only: it never starts, resumes, steers
 * or subscribes to a thread.
 *
 * Attendance is not proven. The documented `thread/read` response carries no attached-client
 * field, and a loaded thread or a live process does not show that a person is attending.
 * `attendance` therefore stays "unverified" until a documented field can prove it.
 */
import { basename, isAbsolute } from "node:path";
import type { CodexCapabilityRpc } from "./capabilities.js";
import type { CodexRuntime } from "./codex.js";
import { canonicalUuid, inspectProcess, processArguments, processRuntime,
  type SessionProcess } from "./process.js";

export interface CodexAppServerBinding {
  provider: "codex";
  version: 1;
  mode: "app-server";
  platform: "darwin" | "linux";
  thread: string;
  process: SessionProcess;
  executable: string;
  socket: string;
  attendance: "unverified";
}

export class CodexAppServerError extends Error {
  constructor(public readonly code: "UNSUPPORTED_PLATFORM" | "INVALID_THREAD" | "INVALID_SOCKET" |
    "NO_APP_SERVER" | "SOCKET_NOT_HELD" | "THREAD_NOT_LOADED" | "STALE_SESSION", message: string) {
    super(message);
    this.name = "CodexAppServerError";
  }
}

const loaded = new Set(["idle", "active"]);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function runtime(overrides: Partial<CodexRuntime>): CodexRuntime {
  return { ...processRuntime(), threadId: process.env.CODEX_THREAD_ID, ...overrides };
}

async function appServerExecutable(row: SessionProcess, os: CodexRuntime): Promise<string> {
  const path = os.platform === "linux" ? await os.readlink(`/proc/${row.pid}/exe`) : row.command;
  if (!isAbsolute(path) || basename(path) !== "codex") throw new Error("native Codex executable unavailable");
  const resolved = await os.realpath(path);
  await os.checkExecutable(resolved);
  return resolved;
}

async function holdsSocket(pid: number, socket: string, os: CodexRuntime): Promise<boolean> {
  try {
    const output = await os.run("/usr/sbin/lsof", ["-a", "-p", String(pid), "-U", "-Fn"]);
    return output.split("\n").some(line => line === `n${socket}`);
  } catch { return false; }
}

async function threadLoaded(rpc: CodexCapabilityRpc, thread: string, signal: AbortSignal): Promise<boolean> {
  const response = await rpc.request("thread/read", { threadId: thread }, { signal });
  if (!record(response) || !record(response.thread)) return false;
  const t = response.thread;
  return t.id === thread && record(t.status) && loaded.has(String(t.status.type));
}

async function processLive(binding: CodexAppServerBinding, os: CodexRuntime): Promise<boolean> {
  const row = await inspectProcess(binding.process.pid, os);
  if (!row || row.parent !== binding.process.parent || row.started !== binding.process.started ||
    row.tty !== binding.process.tty || row.command !== binding.process.command) return false;
  try { return await appServerExecutable(row, os) === binding.executable; }
  catch { return false; }
}

/** Bind the calling tool process's App Server ancestor, its socket and the declared loaded thread. */
export async function bindCodexAppServerSession(
  rpc: CodexCapabilityRpc, socket: string, overrides: Partial<CodexRuntime> = {}, signal = new AbortController().signal,
): Promise<CodexAppServerBinding> {
  const os = runtime(overrides);
  if (os.platform !== "darwin" && os.platform !== "linux") {
    throw new CodexAppServerError("UNSUPPORTED_PLATFORM", "Codex App Server binding supports macOS and Linux only");
  }
  if (!os.threadId || !canonicalUuid.test(os.threadId)) {
    throw new CodexAppServerError("INVALID_THREAD", "CODEX_THREAD_ID must be a canonical UUID");
  }
  if (typeof socket !== "string" || !isAbsolute(socket) || socket.includes("\n")) {
    throw new CodexAppServerError("INVALID_SOCKET", "The App Server socket must be an absolute path");
  }
  let pid = os.pid;
  const seen = new Set<number>();
  while (pid > 1 && !seen.has(pid) && seen.size < 128) {
    seen.add(pid);
    const row = await inspectProcess(pid, os);
    if (!row) break;
    if (basename(row.command) === "codex") {
      // The nearest Codex ancestor must itself be the App Server; never skip to an outer one.
      const args = await processArguments(pid, os);
      if (!args || !/(?:^|\s)app-server(?:\s|$)/.test(args)) break;
      let executable: string;
      try { executable = await appServerExecutable(row, os); }
      catch { throw new CodexAppServerError("NO_APP_SERVER", "The App Server's native executable could not be proven"); }
      if (!await holdsSocket(row.pid, socket, os)) {
        throw new CodexAppServerError("SOCKET_NOT_HELD", "The App Server ancestor does not hold this socket");
      }
      // Never carry raw RPC errors: they may hold credentials or private content.
      if (!await threadLoaded(rpc, os.threadId, signal).catch(() => false)) {
        throw new CodexAppServerError("THREAD_NOT_LOADED", "thread/read does not report the declared thread as loaded");
      }
      const binding: CodexAppServerBinding = {
        provider: "codex", version: 1, mode: "app-server", platform: os.platform,
        thread: os.threadId, process: row, executable, socket, attendance: "unverified",
      };
      if (!await processLive(binding, os)) throw new CodexAppServerError("STALE_SESSION", "App Server changed during binding");
      return binding;
    }
    pid = row.parent;
  }
  throw new CodexAppServerError("NO_APP_SERVER", "No live Codex App Server ancestor");
}

/** Live means the same App Server process, still holding the socket, with the thread still loaded. */
export async function isCodexAppServerSessionLive(
  binding: CodexAppServerBinding, rpc: CodexCapabilityRpc, overrides: Partial<CodexRuntime> = {},
  signal = new AbortController().signal,
): Promise<boolean> {
  const os = runtime(overrides);
  if (binding?.mode !== "app-server" || binding.platform !== os.platform || !canonicalUuid.test(binding.thread)) return false;
  if (!await processLive(binding, os) || !await holdsSocket(binding.process.pid, binding.socket, os)) return false;
  try { return await threadLoaded(rpc, binding.thread, signal); }
  catch { return false; }
}
