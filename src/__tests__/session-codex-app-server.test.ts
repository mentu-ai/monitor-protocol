import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodexCapabilityRpc } from "../session/capabilities.js";
import type { CodexRuntime } from "../session/codex.js";
import { bindCodexAppServerSession, isCodexAppServerSessionLive } from "../session/codex-app-server.js";
import type { SessionProcess } from "../session/process.js";

const thread = "01a122d1-8b16-78b3-b7b2-9ac5acad9328";
const native = "/Users/fixture/.codex/packages/app-server-daemon/releases/0.162.1/bin/codex";
const socket = "/Users/fixture/.codex/app-server.sock";

function fixture() {
  const rows = new Map<number, SessionProcess>([
    [400, { pid: 400, parent: 69, started: "Fri Oct 9 16:51:30 2026", tty: "??", command: "/usr/bin/node" }],
    [69, { pid: 69, parent: 49, started: "Fri Oct 9 16:51:01 2026", tty: "??", command: native.replace(/codex$/, "codex-code-mode-host") }],
    [49, { pid: 49, parent: 33, started: "Fri Oct 9 16:43:34 2026", tty: "??", command: native }],
    [33, { pid: 33, parent: 1, started: "Fri Oct 9 16:38:27 2026", tty: "??", command: native }],
  ]);
  const args = new Map<number, string>([
    [49, `${native} app-server --listen unix:// --managed-daemon`],
    [33, `${native} app-server daemon pid-update-loop`],
  ]);
  let held = [socket];
  let status: unknown = { type: "idle" };
  const calls: { file: string; args: readonly string[] }[] = [];
  const rpcCalls: { method: string; params: Record<string, unknown> }[] = [];
  const runtime: Partial<CodexRuntime> = {
    platform: "darwin", pid: 400, threadId: thread,
    run: async (file, a) => {
      calls.push({ file, args: a });
      const pid = Number(a.at(-1));
      if (file === "/bin/ps" && a.includes("args=")) return `${args.get(pid) ?? rows.get(pid)?.command ?? ""}\n`;
      if (file === "/bin/ps") {
        const row = rows.get(pid);
        if (!row) throw new Error("process vanished");
        return ` ${row.pid} ${row.parent} ${row.started.replace("Oct 9", "Oct  9")} ${row.tty} ${row.command}\n`;
      }
      assert.equal(file, "/usr/sbin/lsof");
      assert.deepEqual(a, ["-a", "-p", "49", "-U", "-Fn"]);
      return `p49\nf12\n${held.map(path => `n${path}`).join("\n")}\n`;
    },
    realpath: async (path) => path,
    checkExecutable: async (path) => { assert.equal(path, native); },
  };
  const rpc: CodexCapabilityRpc = { request: async (method, params) => {
    rpcCalls.push({ method, params });
    assert.equal(method, "thread/read", "never start, resume, steer or subscribe");
    return { thread: { id: params.threadId, status }, readState: null };
  } };
  return { rows, args, calls, rpcCalls, runtime, rpc,
    release: () => { held = []; }, setStatus: (value: unknown) => { status = value; } };
}

test("App Server binding proves the ancestor, its socket and the loaded thread, and leaves attendance unverified", async () => {
  const f = fixture();
  const binding = await bindCodexAppServerSession(f.rpc, socket, f.runtime);
  assert.deepEqual(binding, {
    provider: "codex", version: 1, mode: "app-server", platform: "darwin", thread,
    process: f.rows.get(49), executable: native, socket, attendance: "unverified",
  });
  assert.deepEqual(f.rpcCalls, [{ method: "thread/read", params: { threadId: thread } }]);
  assert.equal(await isCodexAppServerSessionLive(JSON.parse(JSON.stringify(binding)), f.rpc, f.runtime), true);
  assert.ok(f.rpcCalls.every(c => c.method === "thread/read"));
});

test("App Server binding refuses a nearest Codex ancestor that is not the App Server", async () => {
  const f = fixture();
  f.args.set(49, `${native} --profile fixture`);
  await assert.rejects(bindCodexAppServerSession(f.rpc, socket, f.runtime), { code: "NO_APP_SERVER" });
  assert.equal(f.rpcCalls.length, 0);
});

test("App Server binding refuses a socket that the ancestor does not hold, before any RPC", async () => {
  const f = fixture();
  f.release();
  await assert.rejects(bindCodexAppServerSession(f.rpc, socket, f.runtime), { code: "SOCKET_NOT_HELD" });
  assert.equal(f.rpcCalls.length, 0);
});

test("App Server binding refuses an unloaded thread and never carries raw RPC errors", async () => {
  for (const status of [{ type: "notLoaded" }, { type: "systemError" }, null]) {
    const f = fixture();
    f.setStatus(status);
    await assert.rejects(bindCodexAppServerSession(f.rpc, socket, f.runtime), { code: "THREAD_NOT_LOADED" });
  }
  const f = fixture();
  const failing: CodexCapabilityRpc = { request: async () => { throw new Error("bearer secret-token rejected"); } };
  await assert.rejects(bindCodexAppServerSession(failing, socket, f.runtime), (error: Error & { code?: string }) =>
    error.code === "THREAD_NOT_LOADED" && !error.message.includes("secret-token"));
});

test("App Server binding validates the declared thread and socket before running commands", async () => {
  for (const [threadId, path, code] of [
    [undefined, socket, "INVALID_THREAD"],
    ["not-a-thread", socket, "INVALID_THREAD"],
    [thread, "relative.sock", "INVALID_SOCKET"],
  ] as const) {
    const f = fixture();
    await assert.rejects(bindCodexAppServerSession(f.rpc, path, { ...f.runtime, threadId }), { code });
    assert.equal(f.calls.length, 0);
  }
});

test("App Server liveness fails when the thread unloads, the socket is released, or the process restarts", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => f.setStatus({ type: "notLoaded" }),
    (f: ReturnType<typeof fixture>) => f.release(),
    (f: ReturnType<typeof fixture>) => f.rows.set(49, { ...f.rows.get(49)!, started: "Fri Oct 9 23:00:00 2026" }),
  ]) {
    const f = fixture();
    const binding = await bindCodexAppServerSession(f.rpc, socket, f.runtime);
    change(f);
    assert.equal(await isCodexAppServerSessionLive(binding, f.rpc, f.runtime), false);
  }
});
