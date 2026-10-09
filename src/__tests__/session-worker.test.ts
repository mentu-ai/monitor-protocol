import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { BridgeJournal, SessionBridge, runSessionBridge } from "../session/bridge.js";

const bridgeModule = new URL("../session/bridge.js", import.meta.url).href;
const header = { version: 1 as const, adapter: "test", binding: { session: "parent-process-stays-live" },
  source: { base: "https://example.invalid", subscription: "one" } };
function state(t: TestContext) {
  const path = mkdtempSync(join(tmpdir(), "mp-worker-health-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return { path, journal: new BridgeJournal(path, header) };
}

async function childWorker(t: TestContext, idle = false) {
  const f = state(t);
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { writeFileSync } from 'node:fs';
    import { BridgeJournal, SessionBridge, runSessionBridge } from ${JSON.stringify(bridgeModule)};
    const journal = new BridgeJournal(process.env.TEST_STATE);
    const event = { source: 'urn:test:worker', id: 'seven', sequence: '7', data: { value: 'unhandled' } };
    const source = {
      ...journal.header().source, pull: async () => process.env.TEST_IDLE ? null : ({ event, next: 8 }),
      acknowledge: async () => writeFileSync(process.env.TEST_STATE + '/unexpected-ack', 'ack'),
    };
    const adapter = {
      kind: 'test', binding: journal.header().binding,
      isLive: async () => { try { process.kill(Number(process.env.TEST_SESSION_PID), 0); return true; } catch { return false; } },
      enqueue: async () => {},
    };
    const bridge = new SessionBridge(journal, source, adapter, ['test-cli']);
    process.exitCode = await runSessionBridge(bridge, {
      pollMs: 100, onStatus: status => process.send({ status }),
    });
    process.disconnect();
  `], { env: { ...process.env, TEST_STATE: f.path, TEST_SESSION_PID: String(process.pid), TEST_IDLE: idle ? "1" : "" },
    stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let errors = "";
  child.stderr!.on("data", part => { errors += part; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`worker did not queue: ${errors}`)), 10_000);
    const exit = () => { clearTimeout(timer); reject(new Error(`worker exited before queue: ${errors}`)); };
    child.once("exit", exit);
    child.on("message", message => {
      if ((message as { status: string }).status === (idle ? "idle" : "queued")) {
        clearTimeout(timer); child.removeListener("exit", exit); resolve();
      }
    });
  });
  return { ...f, child };
}

async function kill(child: ChildProcess, signal: "SIGTERM" | "SIGKILL") {
  const exited = once(child, "exit");
  assert.equal(child.kill(signal), true);
  return await exited;
}

test("a real worker has private process identity and progress; stale heartbeat is not healthy", async t => {
  const f = await childWorker(t);
  const status = await f.journal.workerStatus();
  assert.equal(status.state, "running");
  assert.equal(status.alive, true);
  assert.equal(status.healthy, true);
  assert.equal(status.record!.process.pid, f.child.pid);
  assert.ok(status.record!.process.started);
  assert.equal(statSync(join(f.path, "worker.json")).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.path, "worker.lock")).mode & 0o777, 0o600);
  const stale = await f.journal.workerStatus(Date.now() + status.record!.stale_after_ms + 1000);
  assert.equal(stale.state, "stale");
  assert.equal(stale.alive, true, "process existence alone is insufficient");
  assert.equal(stale.healthy, false);
  await kill(f.child, "SIGTERM");
});

test("SIGTERM records worker exit and stops delivery while the bound session stays alive", async t => {
  const f = await childWorker(t);
  const delivery = f.journal.pending()!;
  assert.deepEqual(await kill(f.child, "SIGTERM"), [143, null]);
  assert.doesNotThrow(() => process.kill(process.pid, 0), "the bound test session remains alive");
  const status = await new BridgeJournal(f.path).workerStatus();
  assert.equal(status.state, "exited");
  assert.equal(status.alive, false);
  assert.equal(status.healthy, false);
  assert.deepEqual({ code: status.record!.exit!.code, signal: status.record!.exit!.signal,
    reason: status.record!.exit!.reason }, { code: 143, signal: "SIGTERM", reason: "signal" });
  assert.equal(f.journal.stopped(), true);
  assert.equal(existsSync(join(f.path, "worker.lock")), false);
  assert.equal(f.journal.pending()!.id, delivery.id);
  assert.equal(f.journal.receipt(delivery.id), null);
  assert.equal(f.journal.acked(delivery.id), false);
  assert.equal(existsSync(join(f.path, "unexpected-ack")), false);
});

test("SIGKILL is reported as a dead worker and retains pending delivery and lock", async t => {
  const f = await childWorker(t);
  const delivery = f.journal.pending()!;
  assert.deepEqual(await kill(f.child, "SIGKILL"), [null, "SIGKILL"]);
  assert.doesNotThrow(() => process.kill(process.pid, 0));
  const status = await new BridgeJournal(f.path).workerStatus();
  assert.equal(status.state, "dead");
  assert.equal(status.alive, false);
  assert.equal(status.healthy, false);
  assert.equal(status.record!.exit, null, "an uncatchable kill cannot persist an invented exit code");
  assert.equal(f.journal.stopped(), false, "absence of a stop marker is not proof of a running worker");
  assert.equal(existsSync(join(f.path, "worker.lock")), true);
  assert.throws(() => f.journal.lock(), /worker lock exists/, "no automatic lock stealing");
  assert.equal(f.journal.pending()!.id, delivery.id);
  assert.equal(f.journal.receipt(delivery.id), null);
  assert.equal(existsSync(join(f.path, "unexpected-ack")), false);
});

test("an idle bridge killed while its model session remains open is not reported active", async t => {
  const f = await childWorker(t, true);
  assert.equal(f.journal.pending(), null);
  await kill(f.child, "SIGKILL");
  assert.doesNotThrow(() => process.kill(process.pid, 0));
  assert.equal(f.journal.stopped(), false);
  assert.equal(f.journal.pending(), null);
  const status = await f.journal.workerStatus();
  assert.equal(status.state, "dead");
  assert.equal(status.healthy, false);
  assert.equal(status.alive, false);
});

test("legacy journals without worker evidence and mismatched process start identities fail closed", async t => {
  const f = state(t);
  assert.deepEqual(await f.journal.workerStatus(), {
    state: "unrecorded", alive: false, healthy: false, heartbeat_age_ms: null, record: null,
  });
  const release = f.journal.lock();
  const health = await f.journal.startWorker(100);
  try {
    const file = join(f.path, "worker.json");
    const record = JSON.parse(readFileSync(file, "utf8"));
    record.process.started = "different process start";
    writeFileSync(file, JSON.stringify(record));
    const status = await f.journal.workerStatus();
    assert.equal(status.state, "dead");
    assert.equal(status.alive, false, "an existing PID cannot impersonate the recorded worker");
    assert.equal(status.healthy, false);
  } finally { health.finish({ code: 0, signal: null, reason: "stopped" }); release(); }
});

test("fatal worker errors record failure without persisting exception secrets or stealing the next lock", async t => {
  const f = state(t);
  const worker = new SessionBridge(f.journal, {
    ...header.source, pull: async () => { throw new Error("private-transport-detail"); }, acknowledge: async () => {},
  }, { kind: header.adapter, binding: header.binding, isLive: async () => true, enqueue: async () => {} }, ["test"]);
  await assert.rejects(runSessionBridge(worker, { pollMs: 100 }), /private-transport-detail/);
  const status = await f.journal.workerStatus();
  assert.equal(status.state, "exited");
  assert.equal(status.healthy, false);
  assert.equal(status.record!.exit!.code, 1);
  assert.equal(status.record!.exit!.reason, "worker-error");
  assert.equal(readFileSync(join(f.path, "worker.json"), "utf8").includes("private-transport-detail"), false);
  assert.equal(existsSync(join(f.path, "worker.lock")), false);
  f.journal.lock()();
});

test("SIGTERM during an in-flight failing request retains the observed termination reason", async t => {
  const f = state(t);
  const worker = new SessionBridge(f.journal, {
    ...header.source,
    pull: async () => {
      process.kill(process.pid, "SIGTERM");
      await new Promise(resolve => setTimeout(resolve, 20));
      throw new Error("request failed after signal");
    },
    acknowledge: async () => { assert.fail("shutdown cannot acknowledge"); },
  }, { kind: header.adapter, binding: header.binding, isLive: async () => true, enqueue: async () => {} }, ["test"]);
  assert.equal(await runSessionBridge(worker, { pollMs: 100 }), 143);
  const status = await f.journal.workerStatus();
  assert.equal(status.state, "exited");
  assert.equal(status.record!.exit!.code, 143);
  assert.equal(status.record!.exit!.signal, "SIGTERM");
  assert.equal(status.record!.exit!.reason, "signal");
  assert.equal(f.journal.stopped(), true);
  assert.equal(existsSync(join(f.path, "worker.lock")), false);
});
