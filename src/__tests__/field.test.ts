/**
 * The three promises, tested against real processes: durable, shareable, accountable.
 *
 * The other suites call the engine inside one process. These start the command line server as a
 * separate process, kill it without warning, start it again on the same state file, and check what
 * a reader sees afterwards. That is the difference between a promise and a function call.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
type Req = (method: string, path: string, body?: unknown, token?: string) => Promise<{ status: number; body: Json }>;

const entry = resolve(import.meta.dirname, "..", "index.js");
const children = new Set<ChildProcess>();
after(() => {
  for (const c of children) c.kill("SIGKILL");
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const port = typeof a === "object" && a ? a.port : 0;
      s.close(() => res(port));
    });
  });
}

async function waitFor(what: string, check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface Proc {
  child: ChildProcess;
  out: () => string;
  exited: () => boolean;
}

function run(args: string[]): Proc {
  const child = spawn(process.execPath, [entry, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let out = "";
  let done = false;
  child.stdout?.on("data", (d) => { out += d; });
  child.stderr?.on("data", (d) => { out += d; });
  child.on("exit", () => { done = true; children.delete(child); });
  return { child, out: () => out, exited: () => done };
}

async function serve(port: number, state: string): Promise<Proc> {
  const p = run(["serve", "--port", String(port), "--state", state]);
  await waitFor("the server to listen", () => p.out().includes("listening"));
  return p;
}

/** SIGKILL: no shutdown hook, no flush. Whatever is not on disk yet is gone. */
async function hardKill(p: Proc): Promise<void> {
  if (p.exited()) return;
  p.child.kill("SIGKILL");
  await waitFor("the process to exit", () => p.exited());
}

function api(base: string): Req {
  return async (method, path, body, token) => {
    const res = await fetch(`${base}/mp/v0${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Json) : {} };
  };
}

async function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "mp-field-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  return { state: join(dir, "state.json"), port, base, req: api(base) };
}

const PROTO = "ai.mentu.monitor.";
const subjects = (obs: Json[]): string[] => obs.filter((o) => !String(o.type).startsWith(PROTO)).map((o) => String(o.subject));

async function createMonitor(req: Req): Promise<string> {
  const r = await req("POST", "/monitors", {
    id: "ci", name: "CI", owner: "human:you", horizon: "minute", capabilities: ["observe", "act"],
    visibility: "public", types: ["com.example.ci.run", "com.example.ci.review"],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return String(r.body.owner_token);
}

function publish(req: Req, owner: string, subject: string, extra: Json = {}) {
  return req("POST", "/monitors/ci/observations", {
    type: "com.example.ci.run", subject, actor: "probe:ci", origin: "probe", tier: "measured",
    data: { status: "passed" }, ...extra,
  }, owner);
}

async function subscribe(req: Req, subscriber: string, extra: Json = {}): Promise<{ id: string; token: string }> {
  const r = await req("POST", "/subscriptions", { monitor: "ci", subscriber, capabilities: ["observe"], ...extra });
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body));
  return { id: String(r.body.subscription.id), token: String(r.body.token) };
}

const pull = (req: Req, s: { id: string; token: string }) => req("GET", `/subscriptions/${s.id}/pull?limit=100`, undefined, s.token);
const ack = (req: Req, s: { id: string; token: string }, cursor: unknown) => req("POST", `/subscriptions/${s.id}/ack`, { cursor }, s.token);
const printed = (out: string): string[] => [...out.matchAll(/^OBS .*?subject=(build-\d+)/gm)].map((m) => m[1]);

test("durable: what the server acknowledged survives a hard kill", { timeout: 30_000 }, async () => {
  const { state, port, req } = await fresh();
  let server = await serve(port, state);
  const owner = await createMonitor(req);
  const reader = await subscribe(req, "agent:reader");
  for (const s of ["build-1", "build-2", "build-3"]) assert.equal((await publish(req, owner, s)).status, 201);
  const first = await pull(req, reader);
  assert.deepEqual(subjects(first.body.observations), ["build-1", "build-2", "build-3"]);
  assert.equal((await ack(req, reader, first.body.next)).status, 200);
  for (const s of ["build-4", "build-5"]) assert.equal((await publish(req, owner, s)).status, 201);
  assert.deepEqual(subjects((await pull(req, reader)).body.observations), ["build-4", "build-5"], "handed out, not acknowledged");

  await hardKill(server);
  server = await serve(port, state);

  assert.equal((await publish(req, owner, "build-6")).status, 201, "the owner token survived the kill");
  const after = await pull(req, reader);
  assert.equal(after.status, 200, "the reader token survived the kill");
  assert.deepEqual(subjects(after.body.observations), ["build-4", "build-5", "build-6"],
    "exactly what was never acknowledged comes back, and nothing that was");
  const again = after.body.observations.filter((o: Json) => o.subject === "build-4" || o.subject === "build-5");
  assert.ok(again.every((o: Json) => o.redelivered === true), "the two handed out before the kill are marked redelivered");
  await hardKill(server);
});

test("durable: a watch that is stopped and started again prints exactly what arrived in between", { timeout: 30_000 }, async () => {
  const { state, port, base, req } = await fresh();
  const server = await serve(port, state);
  const owner = await createMonitor(req);
  const reader = await subscribe(req, "agent:claude@session");
  const args = ["watch", "--base", base, "--subscription", reader.id, "--token", reader.token, "--wait", "1"];

  const first = run(args);
  for (const s of ["build-1", "build-2"]) await publish(req, owner, s);
  await waitFor("the first watch to print both builds", () => printed(first.out()).includes("build-2"));
  await sleep(300); // it acknowledges right after printing
  first.child.kill("SIGTERM"); // the Monitor tool's deadline, in miniature
  await waitFor("the first watch to stop", () => first.exited());

  for (const s of ["build-3", "build-4", "build-5"]) await publish(req, owner, s);
  const second = run(args);
  await waitFor("the second watch to catch up", () => printed(second.out()).includes("build-5"));
  await sleep(300);
  assert.deepEqual(printed(second.out()), ["build-3", "build-4", "build-5"],
    "nothing that arrived while no watch ran is lost, and nothing already acknowledged is printed again");
  await hardKill(second);
  await hardKill(server);
});

test("durable: a watch keeps going when the server restarts under it", { timeout: 40_000 }, async () => {
  const { state, port, base, req } = await fresh();
  let server = await serve(port, state);
  const owner = await createMonitor(req);
  const reader = await subscribe(req, "agent:claude@session");
  const watcher = run(["watch", "--base", base, "--subscription", reader.id, "--token", reader.token, "--wait", "1"]);
  await publish(req, owner, "build-1");
  await waitFor("the watch to print build-1", () => printed(watcher.out()).includes("build-1"));

  await hardKill(server);
  await sleep(1500); // the watch's next pull finds nobody listening
  server = await serve(port, state);
  await publish(req, owner, "build-2");

  await waitFor("the watch to print build-2 after the restart", () => printed(watcher.out()).includes("build-2"), 15_000)
    .catch((e: Error) => { throw new Error(`${e.message}; watch exited=${watcher.exited()}; output:\n${watcher.out().slice(-600)}`); });
  assert.equal(watcher.exited(), false, "the watch is still running");
  await hardKill(watcher);
  await hardKill(server);
});

test("shareable: readers keep their own places, filters narrow only their own reader, and late readers choose where to start", { timeout: 30_000 }, async () => {
  const { state, port, req } = await fresh();
  let server = await serve(port, state);
  const owner = await createMonitor(req);
  const session = await subscribe(req, "agent:session");
  const dashboard = await subscribe(req, "agent:dashboard", { filter: { "#status": ["failed"] } });
  const builds: [string, string][] = [["build-1", "passed"], ["build-2", "failed"], ["build-3", "passed"], ["build-4", "failed"]];
  for (const [s, status] of builds) await publish(req, owner, s, { tags: { status }, data: { status } });

  const all = await pull(req, session);
  assert.deepEqual(subjects(all.body.observations), ["build-1", "build-2", "build-3", "build-4"]);
  await ack(req, session, all.body.next);
  assert.deepEqual(subjects((await pull(req, dashboard)).body.observations), ["build-2", "build-4"], "the filter narrows the dashboard only");

  await hardKill(server);
  server = await serve(port, state);

  const sessionAfter = await pull(req, session);
  assert.deepEqual(subjects(sessionAfter.body.observations), [], "the session had acknowledged everything");
  assert.equal(sessionAfter.body.lag, 0);
  const dashboardAfter = await pull(req, dashboard);
  assert.deepEqual(subjects(dashboardAfter.body.observations), ["build-2", "build-4"], "the dashboard never acknowledged, so its failures are still waiting");

  const late = await subscribe(req, "agent:late");
  assert.deepEqual(subjects((await pull(req, late)).body.observations), ["build-1", "build-2", "build-3", "build-4"], "a late reader catches up from the start");
  const atHead = await subscribe(req, "agent:head", { from: "head" });
  await publish(req, owner, "build-5");
  assert.deepEqual(subjects((await pull(req, atHead)).body.observations), ["build-5"], "a reader that starts at the head sees only what comes next");
  await hardKill(server);
});

test("accountable: who saw it, who it was for, and every refusal survive a restart", { timeout: 30_000 }, async () => {
  const { state, port, req } = await fresh();
  let server = await serve(port, state);
  const owner = await createMonitor(req);
  const review = { type: "com.example.ci.review", actor: "agent:claude", origin: "human", tier: "src", data: { status: "approved" } };
  assert.equal((await publish(req, owner, "release-review", { ...review, on_behalf_of: "human:you" })).status, 201);
  const stranger = await publish(req, owner, "release-review", { ...review, on_behalf_of: "human:someone-else" });
  assert.equal(stranger.body.code, "PROVENANCE_CEILING");
  const bot = await publish(req, owner, "self-review", { actor: "agent:bot", origin: "agent", tier: "src" });
  assert.equal(bot.body.code, "TIER_NOT_ASSERTABLE");

  await hardKill(server);
  server = await serve(port, state);

  const obs = (await pull(req, await subscribe(req, "agent:auditor"))).body.observations as Json[];
  const kept = obs.find((o) => o.type === "com.example.ci.review");
  assert.ok(kept, "the delegated observation is still there");
  assert.equal(kept.actor, "agent:claude", "the agent that saw it");
  assert.equal(kept.data.provenance.on_behalf_of, "human:you", "the person it worked for");
  assert.equal(kept.tier, "src");
  assert.equal(kept.data.provenance.attested, false, "and the disclosure that nobody vouched for the owner");
  const refusals = obs.filter((o) => o.type === `${PROTO}rejected`).map((o) => o.data.payload.code).sort();
  assert.deepEqual(refusals, ["PROVENANCE_CEILING", "TIER_NOT_ASSERTABLE"], "both refusals are part of the record");
  const st = (await req("GET", "/monitors/ci/state")).body;
  assert.equal(st.counters.rejected, 2);
  assert.ok(st.confidence.gaps.includes("unattested_origin"));
  await hardKill(server);
});

test("durable through the MCP door: an MCP server process keeps its monitors and tokens when it restarts", { timeout: 30_000 }, async () => {
  const { state } = await fresh();
  const connect = async () => {
    const client = new Client({ name: "field", version: "0" }, { capabilities: {} });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry, "mcp", "--state", state] }));
    return client;
  };
  const structured = (r: unknown): Json => (r as { structuredContent: Json }).structuredContent;
  const one = await connect();
  const created = structured(await one.callTool({ name: "monitor_create", arguments: {
    id: "from-mcp", name: "M", owner: "human:you", horizon: "day", capabilities: ["observe"], visibility: "public", types: ["t.x"],
  } }));
  const token = String(created.owner_token);
  const first = await one.callTool({ name: "monitor_publish", arguments: {
    id: "from-mcp", bearer: token, type: "t.x", subject: "first", actor: "probe:x", origin: "probe", tier: "measured", data: {},
  } });
  assert.notEqual(first.isError, true, JSON.stringify(structured(first)));
  await one.close(); // closing the client ends the server process

  const two = await connect();
  const listed = structured(await two.callTool({ name: "monitor_list", arguments: {} }));
  assert.ok((listed.monitors as Json[]).some((m) => m.id === "from-mcp"), "the monitor survived the restart");
  const second = await two.callTool({ name: "monitor_publish", arguments: {
    id: "from-mcp", bearer: token, type: "t.x", subject: "second", actor: "probe:x", origin: "probe", tier: "measured", data: {},
  } });
  assert.notEqual(second.isError, true, "the owner token survived the restart");
  const st = structured(await two.callTool({ name: "monitor_state", arguments: { id: "from-mcp" } }));
  assert.ok(st.counters.observations >= 3, `configured, first and second are all in the log (${st.counters.observations})`);
  await two.close();
});
