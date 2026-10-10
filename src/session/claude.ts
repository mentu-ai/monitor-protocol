/**
 * Bind an already human-opened Claude Code session. Claude Code has no documented command
 * that queues a message into a running session, so this adapter is pull-only: the session
 * reads its own subscription (for example a monitor running `watch`), and nothing here
 * delivers into it. It never starts, resumes or continues a session.
 */
import { basename, isAbsolute } from "node:path";
import { canonicalUuid, imagePath, inspectProcess, processRuntime, terminal,
  type ProcessRuntime, type SessionProcess } from "./process.js";

/** Store privately with the consumer's state. This is a binding, not a credential. */
export interface ClaudeBinding {
  provider: "claude";
  version: 1;
  platform: "darwin" | "linux";
  /** Declared by the host (hook payload or session environment); see ClaudeRuntime.session. */
  session: string;
  process: SessionProcess;
  executable: string;
}

/**
 * The session id is declared, not discovered: pass the `session_id` from a Claude Code hook
 * payload (documented), or it is read from CLAUDE_CODE_SESSION_ID. The other environment
 * values are undocumented and are used only as cross-checks: when present they must agree
 * with the process that the ancestor walk proves.
 */
export interface ClaudeRuntime extends ProcessRuntime {
  session: string | undefined;
  env: {
    claudePid?: string;
    attended?: string;
    entrypoint?: string;
    execPath?: string;
  };
}

export class ClaudeSessionError extends Error {
  constructor(public readonly code: "UNSUPPORTED_PLATFORM" | "INVALID_SESSION" | "NO_LIVE_SESSION" |
    "UNATTENDED" | "EXECUTABLE_UNPROVEN" | "ENVIRONMENT_MISMATCH" | "STALE_SESSION", message: string) {
    super(message);
    this.name = "ClaudeSessionError";
  }
}

function runtime(overrides: Partial<ClaudeRuntime>): ClaudeRuntime {
  return {
    ...processRuntime(),
    session: process.env.CLAUDE_CODE_SESSION_ID,
    env: {
      claudePid: process.env.CLAUDE_PID,
      attended: process.env.CLAUDE_CODE_SESSION_ATTENDED,
      entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
      execPath: process.env.CLAUDE_CODE_EXECPATH,
    },
    ...overrides,
  };
}

async function processExecutable(row: SessionProcess, os: ClaudeRuntime): Promise<string> {
  // ps comm names the launcher ("claude"), not the versioned image. Read this precise
  // process's image; never resolve a possibly different installation from PATH.
  const path = await imagePath(row, os);
  if (!isAbsolute(path)) throw new Error("Claude Code executable unavailable");
  const resolved = await os.realpath(path);
  await os.checkExecutable(resolved);
  return resolved;
}

function validBinding(binding: ClaudeBinding, os: ClaudeRuntime): boolean {
  const row = binding?.process;
  return binding?.provider === "claude" && binding.version === 1 &&
    (binding.platform === "darwin" || binding.platform === "linux") && binding.platform === os.platform &&
    typeof binding.session === "string" && canonicalUuid.test(binding.session) &&
    typeof binding.executable === "string" && isAbsolute(binding.executable) && !!row &&
    Number.isSafeInteger(row.pid) && row.pid > 1 && Number.isSafeInteger(row.parent) && row.parent >= 1 &&
    typeof row.started === "string" && !!row.started && typeof row.tty === "string" && terminal(row.tty) &&
    typeof row.command === "string" && basename(row.command) === "claude";
}

async function isLive(binding: ClaudeBinding, os: ClaudeRuntime): Promise<boolean> {
  if (!validBinding(binding, os)) return false;
  const row = await inspectProcess(binding.process.pid, os);
  if (!row || row.parent !== binding.process.parent || row.started !== binding.process.started ||
    row.tty !== binding.process.tty || row.command !== binding.process.command) return false;
  try { return await processExecutable(row, os) === binding.executable; }
  catch { return false; }
}

async function crossCheck(row: SessionProcess, executable: string, os: ClaudeRuntime): Promise<void> {
  const { claudePid, attended, entrypoint, execPath } = os.env;
  if (attended !== undefined && attended !== "1") {
    throw new ClaudeSessionError("UNATTENDED", "The Claude Code session declares itself unattended");
  }
  if (entrypoint !== undefined && entrypoint !== "cli") {
    throw new ClaudeSessionError("UNATTENDED", "Only the interactive Claude Code CLI is an attended session");
  }
  if (claudePid !== undefined && claudePid !== String(row.pid)) {
    throw new ClaudeSessionError("ENVIRONMENT_MISMATCH", "CLAUDE_PID does not name the proven Claude ancestor");
  }
  if (execPath !== undefined) {
    let declared: string;
    try { declared = await os.realpath(execPath); }
    catch { throw new ClaudeSessionError("ENVIRONMENT_MISMATCH", "CLAUDE_CODE_EXECPATH does not resolve"); }
    if (declared !== executable) {
      throw new ClaudeSessionError("ENVIRONMENT_MISMATCH", "CLAUDE_CODE_EXECPATH is not the running Claude image");
    }
  }
}

/** Bind only the calling process's nearest Claude Code ancestor and the declared session. */
export async function bindClaudeSession(overrides: Partial<ClaudeRuntime> = {}): Promise<ClaudeBinding> {
  const os = runtime(overrides);
  if (os.platform !== "darwin" && os.platform !== "linux") {
    throw new ClaudeSessionError("UNSUPPORTED_PLATFORM", "Claude Code session binding supports macOS and Linux only");
  }
  if (!os.session || !canonicalUuid.test(os.session)) {
    throw new ClaudeSessionError("INVALID_SESSION", "Pass the hook payload's session_id, or run inside the session: it must be a canonical UUID");
  }
  let pid = os.pid;
  const seen = new Set<number>();
  while (pid > 1 && !seen.has(pid) && seen.size < 128) {
    seen.add(pid);
    const row = await inspectProcess(pid, os);
    if (!row) break;
    if (basename(row.command) === "claude") {
      // A headless nearest Claude ancestor (print mode, SDK) must not fall through to an outer terminal.
      if (!terminal(row.tty)) break;
      let executable: string;
      try { executable = await processExecutable(row, os); }
      catch { throw new ClaudeSessionError("EXECUTABLE_UNPROVEN", "The running Claude Code image could not be proven"); }
      await crossCheck(row, executable, os);
      const binding: ClaudeBinding = {
        provider: "claude", version: 1, platform: os.platform,
        session: os.session, process: row, executable,
      };
      if (!await isLive(binding, os)) throw new ClaudeSessionError("STALE_SESSION", "Claude Code session changed during binding");
      return binding;
    }
    pid = row.parent;
  }
  throw new ClaudeSessionError("NO_LIVE_SESSION", "No live attended Claude Code ancestor");
}

/** A stale binding is never repaired by opening, resuming or continuing a session. */
export async function isClaudeSessionLive(binding: ClaudeBinding, overrides: Partial<ClaudeRuntime> = {}): Promise<boolean> {
  return isLive(binding, runtime(overrides));
}
