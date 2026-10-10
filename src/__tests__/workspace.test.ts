import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceStatus, renderWorkspaceStatus, type WorkspaceConfig } from "../workspace.js";

const now = Date.parse("2026-10-10T00:00:00Z");
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "mp-workspace-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config: WorkspaceConfig = { version: 1, workspace: "Shared work", construct: { id: "demo", url: "http://127.0.0.1:8350/c/demo" },
    sourceHealthFile: join(dir, "health.json"), staleAfterMs: 30_000,
    participants: [{ actor: "agent:peer@demo", mode: "attended-session" }] };
  const health = { version: 1, status: "healthy", terminal: false, checked_at: new Date(now).toISOString(),
    last_success: new Date(now).toISOString(), failure_count: 0, worker_heartbeat_at: new Date(now).toISOString() };
  return { config, health, write: (value: unknown) => writeFileSync(config.sourceHealthFile, JSON.stringify(value)) };
}

test("enrolment and source health do not imply participant tool readiness or native wake", async t => {
  const f = fixture(t); f.write(f.health);
  const s = await workspaceStatus(f.config, now);
  assert.equal(s.source.ready, true);
  assert.equal(s.participants[0].transport, "unconfigured");
  assert.equal(s.participants[0].capabilityReadiness, "unverified");
  assert.equal(s.participants[0].nativeWake, "unverified");
});
test("stale, future, failed, unreadable and terminal health cannot be ready", async t => {
  const f = fixture(t);
  assert.equal((await workspaceStatus(f.config, now)).source.ready, false);
  for (const patch of [{ worker_heartbeat_at: new Date(now - 30_001).toISOString() },
    { last_success: new Date(now + 1).toISOString() }, { status: "failed" }, { terminal: true }]) {
    f.write({ ...f.health, ...patch });
    assert.equal((await workspaceStatus(f.config, now)).source.ready, false);
  }
});
test("projection excludes source tokens, arbitrary diagnostics and local paths", async t => {
  const f = fixture(t); f.write({ ...f.health, token: "secret-value", error_class: "private-server-detail" });
  const s = JSON.stringify(await workspaceStatus(f.config, now));
  assert.ok(!s.includes("secret-value") && !s.includes("private-server-detail") && !s.includes(f.config.sourceHealthFile));
});
test("projection allowlists construct fields instead of copying private configuration", async t => {
  const f = fixture(t);
  const config = { ...f.config, construct: { ...f.config.construct,
    credential: "construct-secret-fixture", privatePath: "/private/construct-fixture", nested: { token: "nested-secret" } } };
  const status = await workspaceStatus(config, now);
  assert.deepEqual(status.construct, f.config.construct);
  for (const rendered of [JSON.stringify(status), renderWorkspaceStatus(status)]) {
    assert.ok(!rendered.includes("construct-secret-fixture"));
    assert.ok(!rendered.includes("/private/construct-fixture"));
    assert.ok(!rendered.includes("nested-secret"));
  }
});
test("view escapes actor and construct content and refuses active links or duplicate actors", async t => {
  const f = fixture(t);
  f.config.participants[0].actor = "<script>actor</script>";
  const html = renderWorkspaceStatus(await workspaceStatus(f.config, now));
  assert.ok(!html.includes("<script>actor"));
  assert.ok(html.includes("&lt;script&gt;actor"));
  await assert.rejects(workspaceStatus({ ...f.config, construct: { id: "demo", url: "javascript:alert(1)" } }, now));
  await assert.rejects(workspaceStatus({ ...f.config, participants: [...f.config.participants, ...f.config.participants] }, now));
});
test("missing bridge journal is unavailable, never running or handled", async t => {
  const f = fixture(t); f.config.participants[0].bridgeState = join(f.config.sourceHealthFile, "missing");
  const s = await workspaceStatus(f.config, now);
  assert.equal(s.participants[0].transport, "unavailable");
  assert.equal(s.participants[0].phase, "unknown");
});
