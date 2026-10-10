import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

const example = resolve("examples/codex-capability-trial.mjs");
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
};
async function until(predicate: () => boolean, child: ChildProcess, diagnostics: () => string) {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    assert.equal(child.exitCode, null, diagnostics());
    assert.equal(child.signalCode, null, diagnostics());
    assert.ok(Date.now() < deadline, `stub did not reach initialize: ${diagnostics()}`);
    await delay(10);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`${signal} during initialize cancels admission and stops only the owned trial child`,
    { skip: process.platform === "win32", timeout: 15000 }, async t => {
      const dir = mkdtempSync(join(tmpdir(), "mp-capability-cancel-"));
      const executable = join(dir, "fake-codex"), marker = join(dir, "child.pid"), requests = join(dir, "requests.jsonl");
      const state = join(dir, "trial");
      // This fake executable never calls a model or responds to initialize. The PID marker
      // proves the test signals the parent only after the owned child is handling that RPC.
      writeFileSync(executable, `#!${process.execPath}
const { writeFileSync, appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  appendFileSync(${JSON.stringify(requests)}, JSON.stringify({ method: request.method }) + '\\n');
  if (request.method === 'initialize') writeFileSync(${JSON.stringify(marker)}, String(process.pid));
});
`, { mode: 0o700 });
      const child = spawn(process.execPath, [example, "--codex", executable, "--state", state],
        { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "", ownedPid: number | undefined;
      child.stdout!.on("data", part => { stdout += String(part); });
      child.stderr!.on("data", part => { stderr += String(part); });
      const exited = once(child, "exit");
      t.after(async () => {
        // Only fixture-owned processes are cleanup candidates if a regression strands one.
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        if (ownedPid && alive(ownedPid)) {
          try { process.kill(-ownedPid, "SIGKILL"); } catch { /* already exited */ }
        }
        rmSync(dir, { recursive: true, force: true });
      });
      await until(() => existsSync(marker), child, () => stderr);
      ownedPid = Number(readFileSync(marker, "utf8"));
      assert.ok(Number.isSafeInteger(ownedPid) && ownedPid > 1);
      assert.equal(alive(ownedPid), true);
      assert.equal(child.kill(signal), true);
      const [code, exitSignal] = await exited;
      assert.equal(code, signal === "SIGINT" ? 130 : 143, stderr);
      assert.equal(exitSignal, null, "signal handler must finish cleanup rather than die immediately");
      assert.equal(alive(ownedPid), false, "owned app-server fixture must not be orphaned");
      assert.equal(alive(process.pid), true, "the test/operator process remains alive");
      const result = JSON.parse(readFileSync(join(state, "result.json"), "utf8"));
      assert.equal(result.ok, false); assert.equal(result.error, "trial_cancelled");
      assert.equal(result.cancelled, true); assert.equal(result.cancellationSignal, signal);
      assert.equal(result.runtimeStopped, true); assert.equal(result.childStopped, true);
      assert.equal(result.ownedGroupStopped, true); assert.equal(result.inferenceStarted, false);
      assert.equal(result.receipt, undefined); assert.equal(result.admitted, undefined);
      assert.deepEqual(readFileSync(requests, "utf8").trim().split("\n").map(line => JSON.parse(line).method), ["initialize"]);
      const printed = JSON.parse(stdout.trim());
      assert.equal(printed.cancelled, true); assert.equal(printed.runtimeStopped, true);
    });
}
