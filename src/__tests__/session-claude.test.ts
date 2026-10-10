import assert from "node:assert/strict";
import { test } from "node:test";
import { bindClaudeSession, isClaudeSessionLive, type ClaudeRuntime } from "../session/claude.js";
import { bridgeMain } from "../session/cli.js";
import type { SessionProcess } from "../session/process.js";

const session = "8b8122f3-384d-428b-9194-0abc8186bf04";
const image = "/Users/fixture/.local/share/claude/versions/2.1.296";

function fixture(platform: NodeJS.Platform = "darwin") {
  const rows = new Map<number, SessionProcess>([
    [300, { pid: 300, parent: 200, started: "Fri Oct 9 21:30:01 2026", tty: "ttys001", command: "/usr/bin/node" }],
    [200, { pid: 200, parent: 100, started: "Fri Oct 9 21:25:05 2026", tty: "ttys001", command: "/bin/zsh" }],
    [100, { pid: 100, parent: 90, started: "Fri Oct 9 21:24:36 2026", tty: "ttys001", command: "claude" }],
    [90, { pid: 90, parent: 1, started: "Fri Oct 9 21:24:30 2026", tty: "ttys001", command: "claude" }],
  ]);
  const calls: { file: string; args: readonly string[] }[] = [];
  const links: string[] = [];
  let current = image;
  const runtime: ClaudeRuntime = {
    platform, pid: 300, session,
    env: { claudePid: "100", attended: "1", entrypoint: "cli", execPath: "/Users/fixture/.local/bin/claude" },
    run: async (file, args) => {
      calls.push({ file, args });
      if (file === "/bin/ps") {
        const row = rows.get(Number(args.at(-1)));
        if (!row) throw new Error("process vanished");
        return ` ${row.pid} ${row.parent} ${row.started.replace("Oct 9", "Oct  9")} ${row.tty} ${row.command}\n`;
      }
      assert.equal(file, "/usr/sbin/lsof", "never start, resume or continue a Claude session");
      assert.deepEqual(args.slice(0, 2), ["-a", "-p"]);
      return `p${args[2]}\nftxt\nn${current}\nftxt\nn/usr/lib/dyld\n`;
    },
    readlink: async (path) => { links.push(path); return current; },
    // The launcher symlink resolves to the versioned image.
    realpath: async (path) => path === "/Users/fixture/.local/bin/claude" ? image : path,
    checkExecutable: async (path) => { assert.ok(path === image || path === current); },
  };
  return { rows, calls, links, runtime, replaceImage: (path: string) => { current = path; } };
}

test("Claude binds the nearest attended Claude Code ancestor, proves its image, and round trips through JSON", async () => {
  const f = fixture();
  const binding = await bindClaudeSession(f.runtime);
  assert.deepEqual(binding, {
    provider: "claude", version: 1, platform: "darwin", session,
    process: f.rows.get(100), executable: image,
  });
  assert.equal(await isClaudeSessionLive(JSON.parse(JSON.stringify(binding)), f.runtime), true);
  assert.ok(f.calls.every(c => c.file === "/bin/ps" || c.file === "/usr/sbin/lsof"), "binding only reads process tables");
  assert.deepEqual(f.links, [], "macOS reads the image through lsof, not /proc");
});

test("Claude Linux binding reads the image through /proc", async () => {
  const f = fixture("linux");
  const binding = await bindClaudeSession(f.runtime);
  assert.equal(binding.executable, image);
  assert.ok(f.links.length && f.links.every(path => path === "/proc/100/exe"));
  assert.ok(!f.calls.some(c => c.file === "/usr/sbin/lsof"));
});

test("Claude refuses Windows and a missing or malformed session id before running commands", async () => {
  for (const [platform, id, code] of [
    ["win32", session, "UNSUPPORTED_PLATFORM"],
    ["darwin", undefined, "INVALID_SESSION"],
    ["darwin", "not-a-session", "INVALID_SESSION"],
    ["darwin", session.toUpperCase(), "INVALID_SESSION"],
  ] as const) {
    const f = fixture(platform);
    await assert.rejects(bindClaudeSession({ ...f.runtime, session: id }), { code });
    assert.equal(f.calls.length, 0);
  }
});

test("Claude environment values only cross-check the proven process and never replace it", async () => {
  for (const [env, code] of [
    [{ attended: "0" }, "UNATTENDED"],
    [{ entrypoint: "sdk-ts" }, "UNATTENDED"],
    [{ claudePid: "90" }, "ENVIRONMENT_MISMATCH"],
    [{ execPath: "/Users/fixture/.local/share/claude/versions/2.1.271" }, "ENVIRONMENT_MISMATCH"],
  ] as const) {
    const f = fixture();
    await assert.rejects(bindClaudeSession({ ...f.runtime, env: { ...f.runtime.env, ...env } }), { code });
  }
  const f = fixture();
  const binding = await bindClaudeSession({ ...f.runtime, env: {} });
  assert.equal(binding.process.pid, 100, "absent environment values are not required");
});

test("Claude refuses a headless nearest ancestor instead of falling through to an outer session", async () => {
  const f = fixture();
  f.rows.set(100, { ...f.rows.get(100)!, tty: "??" });
  await assert.rejects(bindClaudeSession(f.runtime), { code: "NO_LIVE_SESSION" });
});

test("Claude refuses when the running image cannot be proven", async () => {
  const f = fixture();
  await assert.rejects(bindClaudeSession({ ...f.runtime, run: async (file, args) => {
    if (file === "/usr/sbin/lsof") throw new Error("lsof unavailable");
    return f.runtime.run(file, args);
  } }), { code: "EXECUTABLE_UNPROVEN" });
});

test("Claude liveness fails on PID reuse, exit, or a replaced image", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => f.rows.set(100, { ...f.rows.get(100)!, started: "Fri Oct 9 22:00:00 2026" }),
    (f: ReturnType<typeof fixture>) => f.rows.delete(100),
    (f: ReturnType<typeof fixture>) => f.replaceImage("/Users/fixture/.local/share/claude/versions/2.1.300"),
  ]) {
    const f = fixture();
    const binding = await bindClaudeSession(f.runtime);
    change(f);
    assert.equal(await isClaudeSessionLive(binding, f.runtime), false);
  }
  const f = fixture();
  const binding = await bindClaudeSession(f.runtime);
  assert.equal(await isClaudeSessionLive({ ...binding, session: "other" }, f.runtime), false);
});

test("the bridge refuses Claude as pull-only rather than pretending to queue into it", async () => {
  await assert.rejects(bridgeMain(["run", "--state", "/nonexistent/claude-bridge", "--adapter", "claude"]), /pull-only/);
});
