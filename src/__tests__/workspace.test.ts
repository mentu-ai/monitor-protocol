import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceStatus, renderWorkspaceStatus, type WorkspaceConfig } from "../workspace.js";
import { BridgeJournal } from "../session/bridge.js";
import type { Observation } from "../types.js";

const now = Date.parse("2026-10-10T00:00:00Z");
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "mp-workspace-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config: WorkspaceConfig = { version: 1, workspace: "Shared work", construct: { id: "demo", url: "http://127.0.0.1:8350/c/demo" },
    sourceHealthFile: join(dir, "health.json"), staleAfterMs: 30_000,
    participants: [{ actor: "agent:peer@demo", mode: "attended-session" }] };
  const health = { version: 1, status: "healthy", terminal: false, checked_at: new Date(now).toISOString(),
    last_success: new Date(now).toISOString(), failure_count: 0, worker_heartbeat_at: new Date(now).toISOString() };
  return { dir, config, health, write: (value: unknown) => writeFileSync(config.sourceHealthFile, JSON.stringify(value)) };
}

function journalFixture(t: TestContext) {
  const f = fixture(t);
  f.config.participants[0].bridgeState = join(f.dir, "bridge");
  const journal = new BridgeJournal(f.config.participants[0].bridgeState, { version: 1, adapter: "fixture",
    binding: { thread: "private-session-fixture" }, source: { base: "https://example.invalid", subscription: "private-subscription" } });
  const event: Observation = { specversion: "1.0", source: "urn:example:fixture", id: "7", sequence: "7",
    type: "com.example.change", time: new Date(now).toISOString(), tier: "measured", origin: "probe",
    verified: "unverified", actor: "test", horizon: "minute", data: { secret: "private-observation-body",
      provenance: { origin: "probe", tier: "measured", verification: "unverified", actor: "test" } } };
  const bytes = () => Object.fromEntries(readdirSync(journal.path).sort().map(name => [name, readFileSync(join(journal.path, name), "base64")]));
  const patch = (name: string, value: object) => {
    const path = join(journal.path, name);
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...value }));
  };
  return { ...f, journal, event, bytes, patch };
}

test("enrolment and source health do not imply participant tool readiness or native wake", async t => {
  const f = fixture(t); f.write(f.health);
  const s = await workspaceStatus(f.config, now);
  assert.equal(s.source.ready, true);
  assert.equal(s.participants[0].transport, "unconfigured");
  assert.equal(s.participants[0].capabilityReadiness, "unverified");
  assert.equal(s.participants[0].nativeWake, "unverified");
  assert.deepEqual(s.participants[0].handling, { state: "unobserved", createdAt: null, ageMs: null, dueAt: null, handledAt: null });
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
  assert.equal(s.participants[0].handling.state, "unobserved");
});

test("valid empty journal proves no pending delivery; an absent deadline policy creates no deadline", async t => {
  const f = journalFixture(t);
  const before = f.bytes();
  const empty = await workspaceStatus(f.config, now);
  assert.equal(empty.participants[0].handling.state, "no-pending-delivery");
  assert.deepEqual(f.bytes(), before);
  const item = f.journal.add(f.event, 8), created = Date.parse(item.created);
  const pending = (await workspaceStatus(f.config, created + 86_400_001)).participants[0];
  assert.equal(pending.handling.state, "awaiting-handling");
  assert.equal(pending.handling.ageMs, 86_400_001);
  assert.equal(pending.handling.dueAt, null);
});

test("queued delivery can be overdue while its worker is alive; queueing, redelivery and reopening do not reset the deadline", async t => {
  const f = journalFixture(t); f.config.participants[0].handlingWithinMs = 1000;
  const item = f.journal.add(f.event, 8), created = Date.parse(item.created);
  const release = f.journal.lock();
  try { (await f.journal.startWorker(1000)).heartbeat("queued-private-diagnostic"); }
  finally { release(); }
  f.journal.markQueued(item.id);
  const before = f.bytes();
  const awaiting = (await workspaceStatus(f.config, created + 999)).participants[0];
  const overdue = (await workspaceStatus(f.config, created + 1000)).participants[0];
  assert.equal(awaiting.handling.state, "awaiting-handling");
  assert.equal(overdue.transport, "running");
  assert.equal(overdue.worker, "running");
  assert.equal(overdue.phase, "queued");
  assert.deepEqual(overdue.handling, { state: "handling-overdue", createdAt: item.created, ageMs: 1000,
    dueAt: new Date(created + 1000).toISOString(), handledAt: null });
  assert.deepEqual(f.bytes(), before, "projection does not alter journal bytes");
  f.journal.markQueued(item.id);
  const reopened = new BridgeJournal(f.journal.path);
  assert.equal(reopened.add({ ...f.event, redelivered: true }, 8).created, item.created);
  const afterRetry = f.bytes();
  assert.equal((await workspaceStatus(f.config, created + 1001)).participants[0].handling.dueAt, overdue.handling.dueAt);
  assert.deepEqual(f.bytes(), afterRetry);
});

test("invalid worker diagnostics cannot hide independently valid overdue delivery evidence", async t => {
  for (const invalid of ["malformed", "permissions"]) {
    const f = journalFixture(t); f.config.participants[0].handlingWithinMs = 1000;
    const item = f.journal.add(f.event, 8), created = Date.parse(item.created);
    f.journal.markQueued(item.id);
    const release = f.journal.lock();
    try { await f.journal.startWorker(1000); }
    finally { release(); }
    const workerPath = join(f.journal.path, "worker.json");
    if (invalid === "malformed") writeFileSync(workerPath, "{private-broken-worker-diagnostic");
    else chmodSync(workerPath, 0o644);
    const before = f.bytes(), mode = statSync(workerPath).mode;
    const status = await workspaceStatus(f.config, created + 1000), participant = status.participants[0];
    assert.equal(participant.worker, "unknown");
    assert.equal(participant.transport, "unavailable");
    assert.equal(participant.delivery, item.id);
    assert.equal(participant.phase, "queued");
    assert.deepEqual(participant.handling, { state: "handling-overdue", createdAt: item.created, ageMs: 1000,
      dueAt: new Date(created + 1000).toISOString(), handledAt: null });
    assert.ok(!JSON.stringify(status).includes("private-broken-worker-diagnostic"));
    assert.deepEqual(f.bytes(), before);
    assert.equal(statSync(workerPath).mode, mode);
    f.patch("binding.json", { version: 2 });
    const invalidBinding = (await workspaceStatus(f.config, created + 1000)).participants[0];
    assert.equal(invalidBinding.delivery, null);
    assert.equal(invalidBinding.handling.state, "evidence-invalid");
  }
});

test("valid handling remains distinct from acknowledgement and views contain only allowlisted metadata", async t => {
  const f = journalFixture(t); f.config.participants[0].handlingWithinMs = 1000;
  const item = f.journal.add(f.event, 8), created = Date.parse(item.created);
  f.journal.markQueued(item.id);
  f.journal.handle(item.id, "private-disposition-reference");
  f.patch(`receipt-${item.id}.json`, { handled: new Date(created + 500).toISOString(), token: "private-receipt-token" });
  const before = f.bytes();
  const status = await workspaceStatus(f.config, created + 1000), participant = status.participants[0];
  assert.equal(participant.phase, "handled");
  assert.equal(participant.handling.state, "handled-awaiting-ack");
  assert.equal(participant.handling.handledAt, new Date(created + 500).toISOString());
  assert.equal(participant.handling.dueAt, new Date(created + 1000).toISOString());
  const html = renderWorkspaceStatus(status);
  assert.ok(html.includes("<th>Handling</th>"));
  assert.ok(html.includes("handled-awaiting-ack") && html.includes(participant.handling.dueAt!));
  for (const view of [JSON.stringify(status), html]) {
    for (const privateValue of ["private-observation-body", "private-disposition-reference", "private-receipt-token",
      "private-session-fixture", "private-subscription", f.journal.path]) assert.ok(!view.includes(privateValue));
  }
  assert.deepEqual(f.bytes(), before);
  f.journal.markAcknowledged(item.id);
  const acknowledgedBytes = f.bytes();
  const acknowledged = (await workspaceStatus(f.config, created + 1001)).participants[0];
  assert.equal(acknowledged.delivery, null);
  assert.equal(acknowledged.phase, "idle");
  assert.deepEqual(acknowledged.handling, { state: "no-pending-delivery", createdAt: null, ageMs: null, dueAt: null, handledAt: null });
  assert.deepEqual(f.bytes(), acknowledgedBytes);
});

test("malformed or future delivery times and reversed, future or malformed receipt times are invalid evidence", async t => {
  const f = journalFixture(t); f.config.participants[0].handlingWithinMs = 1000;
  const item = f.journal.add(f.event, 8), created = Date.parse(item.created), observed = created + 1000;
  for (const value of [null, 123, "private-invalid-time", "2026-02-30T00:00:00.000Z", new Date(observed + 1).toISOString()]) {
    f.patch(`delivery-${item.id}.json`, { created: value });
    const before = f.bytes();
    const status = (await workspaceStatus(f.config, observed)).participants[0];
    assert.equal(status.handling.state, "evidence-invalid");
    assert.equal(status.phase, "unknown");
    assert.equal(status.handling.createdAt, null);
    assert.deepEqual(f.bytes(), before);
  }
  f.patch(`delivery-${item.id}.json`, { created: item.created });
  f.journal.handle(item.id, "private-disposition-reference");
  for (const value of [new Date(created - 1).toISOString(), new Date(observed + 1).toISOString(), "private-invalid-time", null]) {
    f.patch(`receipt-${item.id}.json`, { handled: value });
    const before = f.bytes();
    const status = await workspaceStatus(f.config, observed);
    assert.equal(status.participants[0].handling.state, "evidence-invalid");
    assert.notEqual(status.participants[0].phase, "handled");
    assert.ok(!JSON.stringify(status).includes("private-invalid-time"));
    assert.deepEqual(f.bytes(), before);
  }
});

test("operator handling deadlines are bounded safe integers", async t => {
  const f = fixture(t);
  for (const value of [null, "1000", NaN, Infinity, 0, 999, 1000.5, 86_400_001, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(workspaceStatus({ ...f.config, participants: [{ ...f.config.participants[0], handlingWithinMs: value }] }, now),
      /invalid or duplicate workspace participant/);
  }
  for (const value of [1000, 86_400_000]) {
    const status = await workspaceStatus({ ...f.config, participants: [{ ...f.config.participants[0], handlingWithinMs: value }] }, now);
    assert.equal(status.participants[0].handling.state, "unobserved");
    assert.equal(status.participants[0].handling.dueAt, null);
  }
});
