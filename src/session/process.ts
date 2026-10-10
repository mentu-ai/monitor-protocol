/** Process identity shared by the session adapters. Production uses execFile, never a shell. */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readlink, realpath, stat } from "node:fs/promises";

export interface SessionProcess {
  pid: number;
  parent: number;
  started: string;
  tty: string;
  command: string;
}

/** Injectable OS boundary for tests and embedders. */
export interface ProcessRuntime {
  platform: NodeJS.Platform;
  pid: number;
  run: (file: string, args: readonly string[]) => Promise<string>;
  realpath: (path: string) => Promise<string>;
  readlink: (path: string) => Promise<string>;
  checkExecutable: (path: string) => Promise<void>;
}

export const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const terminal = (tty: string) => !!tty && !["?", "??", "-", "none"].includes(tty);

export function processRuntime(): ProcessRuntime {
  return {
    platform: process.platform,
    pid: process.pid,
    run: (file, args) => new Promise((resolve, reject) => {
      execFile(file, [...args], {
        encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024,
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
      }, (error, stdout) => error ? reject(error) : resolve(stdout));
    }),
    realpath,
    readlink,
    checkExecutable: async (path) => {
      if (!(await stat(path)).isFile()) throw new Error("not a file");
      await access(path, constants.X_OK);
    },
  };
}

export async function inspectProcess(pid: number, os: ProcessRuntime): Promise<SessionProcess | null> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    // lstart plus parent and terminal protects against ordinary PID reuse and detachment.
    // Keep the final field intact: the native installation path can contain spaces.
    const output = await os.run("/bin/ps", ["-ww", "-o", "pid=,ppid=,lstart=,tty=,comm=", "-p", String(pid)]);
    const match = output.trim().match(/^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(\S+)\s+(.+)$/);
    if (!match || Number(match[1]) !== pid) return null;
    return {
      pid, parent: Number(match[2]), started: match[3].replace(/\s+/g, " "),
      tty: match[4], command: match[5],
    };
  } catch { return null; }
}

/** The full argument vector of one process, for roles that ps comm cannot show. */
export async function processArguments(pid: number, os: ProcessRuntime): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try { return (await os.run("/bin/ps", ["-ww", "-o", "args=", "-p", String(pid)])).trim() || null; }
  catch { return null; }
}

/** The executable image of this precise process: /proc on Linux, lsof's txt entry on macOS. */
export async function imagePath(row: SessionProcess, os: ProcessRuntime): Promise<string> {
  if (os.platform === "linux") return os.readlink(`/proc/${row.pid}/exe`);
  const output = await os.run("/usr/sbin/lsof", ["-a", "-p", String(row.pid), "-d", "txt", "-Fn"]);
  const name = output.split("\n").find(line => line.startsWith("n"));
  if (!name) throw new Error("process image unavailable");
  return name.slice(1);
}
