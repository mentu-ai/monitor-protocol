import assert from "node:assert/strict";
import { test } from "node:test";
import { bindCodexSession, CodexQueueRetryError, enqueueCodex, isCodexSessionLive, type CodexBinding, type CodexProcess, type CodexRuntime } from "../session/codex.js";

const thread = "abcdef01-2222-4333-8444-555555555555";
const native = "/Applications/Codex Native/vendor/bin/codex";

function fixture(platform: NodeJS.Platform = "darwin") {
  const rows = new Map<number, CodexProcess>([
    [300, { pid: 300, parent: 200, started: "Fri Oct 9 13:01:01 2026", tty: "ttys003", command: "/usr/bin/node" }],
    [200, { pid: 200, parent: 100, started: "Fri Oct 9 13:00:01 2026", tty: "ttys003", command: "/bin/zsh" }],
    [100, { pid: 100, parent: 50, started: "Fri Oct 9 12:00:01 2026", tty: "ttys003", command: platform === "linux" ? "codex" : native }],
  ]);
  const calls: { file: string; args: readonly string[] }[] = [];
  const links: string[] = [];
  const runtime: CodexRuntime = {
    platform, pid: 300, threadId: thread,
    run: async (file, args) => {
      calls.push({ file, args });
      if (file === "/bin/ps") {
        const row = rows.get(Number(args.at(-1)));
        if (!row) throw new Error("process vanished");
        // BSD ps pads single-digit dates; normalize only whitespace in the start time.
        return ` ${row.pid} ${row.parent} ${row.started.replace("Oct 9", "Oct  9")} ${row.tty} ${row.command}\n`;
      }
      assert.equal(file, native, "never resolve Codex using PATH");
      if (args[0] === "queue" && args[1] === "--help") return "Usage: codex queue --thread <UUID> --message <TEXT>";
      assert.equal(args[0], "queue", "never start, resume, or exec a model session");
      return "queued";
    },
    readlink: async (path) => { links.push(path); return native; },
    realpath: async (path) => path,
    checkExecutable: async (path) => { assert.equal(path, native); },
  };
  return { rows, calls, links, runtime };
}

test("Codex binds the calling native terminal, keeps its executable with spaces, and round trips through JSON", async () => {
  const f = fixture();
  const binding = await bindCodexSession(f.runtime);
  assert.deepEqual(binding, {
    provider: "codex", version: 1, platform: "darwin", thread,
    process: f.rows.get(100), executable: native,
  });
  assert.equal(await isCodexSessionLive(JSON.parse(JSON.stringify(binding)), f.runtime), true);
  assert.equal(f.calls.filter(c => c.file !== "/bin/ps").length, 1, "binding only probes queue help");
  assert.deepEqual(f.calls.find(c => c.file === native)?.args, ["queue", "--help"]);
  assert.deepEqual(f.links, [], "macOS uses the native process path");
});

test("Codex Linux binding resolves the executable through /proc rather than ps comm or PATH", async () => {
  const f = fixture("linux");
  const binding = await bindCodexSession(f.runtime);
  assert.equal(binding.process.command, "codex");
  assert.equal(binding.executable, native);
  assert.ok(f.links.every(path => path === "/proc/100/exe"));
  await enqueueCodex(binding, "delivery metadata", f.runtime);
  assert.deepEqual(f.calls.at(-1), { file: native, args: ["queue", "--thread", thread, "--message", "delivery metadata"] });
});

test("Codex passes notification text as one literal argument and only queues the bound thread", async () => {
  const f = fixture();
  const binding = await bindCodexSession(f.runtime);
  const message = "Observation `touch /tmp/never`; $(echo secret)\n--thread another-thread";
  await enqueueCodex(binding, message, f.runtime);
  assert.deepEqual(f.calls.at(-1), { file: native, args: ["queue", "--thread", thread, "--message", message] });
});

test("Codex rejects Windows and malformed or absent native thread declarations before running commands", async () => {
  for (const [platform, threadId, code] of [
    ["win32", thread, "UNSUPPORTED_PLATFORM"],
    ["darwin", undefined, "INVALID_THREAD"],
    ["darwin", "not-a-thread", "INVALID_THREAD"],
    ["darwin", thread.toUpperCase(), "INVALID_THREAD"],
  ] as const) {
    const f = fixture(platform);
    await assert.rejects(bindCodexSession({ ...f.runtime, threadId }), { code });
    assert.equal(f.calls.length, 0);
  }
});

test("Codex refuses a missing or headless native ancestor, even when an outer Codex has a terminal", async () => {
  for (const tty of ["?", "??", "-", "none", null]) {
    const f = fixture();
    if (tty === null) f.rows.delete(100);
    else f.rows.get(100)!.tty = tty;
    f.rows.set(50, { ...f.rows.get(200)!, pid: 50, parent: 1, command: native });
    await assert.rejects(bindCodexSession(f.runtime), { code: "NO_LIVE_SESSION" });
    assert.equal(f.calls.filter(c => c.file === native).length, 0);
  }
});

test("Codex refuses process cycles and a ps response for a different PID", async () => {
  const f = fixture();
  f.rows.get(200)!.parent = 300;
  await assert.rejects(bindCodexSession(f.runtime), { code: "NO_LIVE_SESSION" });
  assert.equal(f.calls.length, 2);
  await assert.rejects(bindCodexSession({ ...f.runtime, run: async () => "301 200 Fri Oct 9 13:01:01 2026 ttys003 /usr/bin/node" }), { code: "NO_LIVE_SESSION" });
});

test("Codex refuses a native executable without both queue flags or without executable access", async () => {
  for (const help of ["Usage: codex", "queue --thread UUID", "queue --message TEXT", "queue --threaded --messages"]) {
    const f = fixture();
    const run = f.runtime.run;
    f.runtime.run = (file, args) => file === native ? Promise.resolve(help) : run(file, args);
    await assert.rejects(bindCodexSession(f.runtime), { code: "QUEUE_UNAVAILABLE" });
  }
  const f = fixture();
  f.runtime.checkExecutable = async () => { throw new Error("not executable"); };
  await assert.rejects(bindCodexSession(f.runtime), { code: "QUEUE_UNAVAILABLE" });
  assert.equal(f.calls.filter(c => c.file === native).length, 0);
});

test("Codex detects process replacement during queue capability discovery", async () => {
  const f = fixture();
  const run = f.runtime.run;
  f.runtime.run = async (file, args) => {
    const result = await run(file, args);
    if (file === native) f.rows.get(100)!.started = "Fri Oct 9 13:12:00 2026";
    return result;
  };
  await assert.rejects(bindCodexSession(f.runtime), { code: "STALE_SESSION" });
});

test("Codex refuses delivery after death, PID reuse, reparenting, terminal change, command change, or path substitution", async () => {
  const mutations: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.rows.delete(100); },
    f => { f.rows.get(100)!.started = "Fri Oct 9 14:00:01 2026"; },
    f => { f.rows.get(100)!.parent = 1; },
    f => { f.rows.get(100)!.tty = "ttys004"; },
    f => { f.rows.get(100)!.command = "/other/codex"; },
    f => { f.runtime.realpath = async () => "/replacement/codex"; f.runtime.checkExecutable = async () => {}; },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    const binding = await bindCodexSession(f.runtime);
    mutate(f);
    assert.equal(await isCodexSessionLive(binding, f.runtime), false);
    const before = f.calls.filter(c => c.file === native).length;
    await assert.rejects(enqueueCodex(binding, "retained event", f.runtime), { code: "STALE_SESSION" });
    assert.equal(f.calls.filter(c => c.file === native).length, before, "stale binding never invokes queue");
  }
});

test("Codex rejects malformed stored bindings without running arbitrary executables", async () => {
  const f = fixture();
  const binding = await bindCodexSession(f.runtime);
  for (const value of [null, {}, { ...binding, platform: "win32" }, { ...binding, thread: "--help" },
    { ...binding, executable: "codex" }, { ...binding, process: { ...binding.process, pid: -1 } }]) {
    assert.equal(await isCodexSessionLive(value as CodexBinding, f.runtime), false);
  }
});

test("Codex queue failure or timeout is uncertain and does not spawn a replacement session", async () => {
  const f = fixture();
  const binding = await bindCodexSession(f.runtime);
  const run = f.runtime.run;
  f.runtime.run = async (file, args) => {
    const result = await run(file, args);
    if (file === native) throw new Error("timeout after possible enqueue");
    return result;
  };
  await assert.rejects(enqueueCodex(binding, "delivery id is stable", f.runtime), CodexQueueRetryError);
  assert.deepEqual(f.calls.filter(c => c.file === native).map(c => c.args[0]), ["queue", "queue"]);
});

test("Codex queue failure after terminal death stops instead of retrying", async () => {
  const f = fixture();
  const binding = await bindCodexSession(f.runtime);
  const run = f.runtime.run;
  f.runtime.run = async (file, args) => {
    const result = await run(file, args);
    if (file === native) { f.rows.delete(100); throw new Error("session died"); }
    return result;
  };
  await assert.rejects(enqueueCodex(binding, "retain for future explicit binding", f.runtime), { code: "STALE_SESSION" });
});

test("Codex refuses empty, oversized, or NUL-containing notifications without queueing", async () => {
  const f = fixture();
  const binding = await bindCodexSession(f.runtime);
  for (const message of ["", "hello\0world", "x".repeat(32 * 1024 + 1)]) {
    await assert.rejects(enqueueCodex(binding, message, f.runtime), TypeError);
  }
  assert.equal(f.calls.filter(c => c.file === native).length, 1);
});
