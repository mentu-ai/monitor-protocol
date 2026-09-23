import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

/** True while a process with this id exists, including one owned by another user. */
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

/**
 * One writer per state file. Two servers on one file would each overwrite the other's snapshot,
 * and neither would notice. The lock file holds the writer's process id; a lock whose process is
 * gone (a crash, a SIGKILL) is stale and is taken over. Returns the function that releases it.
 */
export function acquireStateLock(statePath: string): () => void {
  const lock = `${statePath}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, "wx");
      try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
      return () => {
        try { if (readFileSync(lock, "utf8").trim() === String(process.pid)) unlinkSync(lock); } catch { /* already gone */ }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let holder = NaN;
      try { holder = Number(readFileSync(lock, "utf8").trim()); } catch { /* vanished between the two calls */ }
      if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && alive(holder))
        throw new Error(`another server (pid ${holder}) is writing ${statePath}. Stop it, or give this one its own --state file.`);
      try { unlinkSync(lock); } catch { /* someone else cleaned it up */ }
    }
  }
  throw new Error(`could not take the lock on ${statePath}`);
}
