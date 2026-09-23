/**
 * Hardening: what a local hub must refuse, and what it must survive.
 *
 * A Monitor Protocol server usually runs on the same machine as a web browser. These tests check
 * that a web page cannot drive it, that one oversized request cannot exhaust it, and that a
 * damaged state file does not take everything with it.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { MonitorService } from "../server/core.js";
import { createHttpServer, listen } from "../server/http.js";
import { MemoryStore } from "../store.js";

type Json = Record<string, any>;
interface Raw { status: number; headers: Record<string, unknown>; body: Json }

/** node:http rather than fetch, because a test here has to set Host and Origin itself. */
function raw(port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<Raw> {
  return new Promise((res, rej) => {
    const r = request({ host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path, headers: opts.headers ?? {} }, (resp) => {
      let data = "";
      resp.on("data", (d) => { data += d; });
      resp.on("end", () => {
        let body: Json = {};
        try { body = data ? (JSON.parse(data) as Json) : {}; } catch { body = { raw: data }; }
        res({ status: resp.statusCode ?? 0, headers: resp.headers, body });
      });
    });
    r.on("error", rej);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

const monitorBody = (id: string, name = id) =>
  JSON.stringify({ id, name, horizon: "day", capabilities: ["observe"], visibility: "public" });

const service = new MonitorService(new MemoryStore());
const server = createHttpServer(service, { allowOrigins: ["https://dash.example"] });
const bound = await listen(server, 0);
after(() => bound.close());

test("a web page on another origin is refused, so a site you visit cannot drive your local hub", async () => {
  const foreign = await raw(bound.port, { path: "/mp/v0/discover", headers: { origin: "https://evil.example" } });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.body.code, "ORIGIN_REFUSED");

  // A plain-text POST is a "simple" cross-site request: the browser sends it without asking first.
  const planted = await raw(bound.port, {
    method: "POST", path: "/mp/v0/monitors",
    headers: { origin: "https://evil.example", "content-type": "text/plain" }, body: monitorBody("planted"),
  });
  assert.equal(planted.status, 403);
  assert.equal(service.store.monitors.has("planted"), false, "the write never reached the engine");

  const allowed = await raw(bound.port, { path: "/mp/v0/discover", headers: { origin: "https://dash.example" } });
  assert.equal(allowed.status, 200, "an origin the operator allowed is served");
  assert.equal(allowed.headers["access-control-allow-origin"], "https://dash.example");
  const preflight = await raw(bound.port, {
    method: "OPTIONS", path: "/mp/v0/monitors",
    headers: { origin: "https://dash.example", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" },
  });
  assert.equal(preflight.status, 204, "and its browser may ask before writing");

  const noOrigin = await raw(bound.port, { path: "/mp/v0/discover" });
  assert.equal(noOrigin.status, 200, "tools that send no Origin, such as curl and watch, are served as before");
});

test("a Host that does not name this server is refused on a loopback connection, so DNS rebinding cannot reach it", async () => {
  const rebound = await raw(bound.port, { path: "/mp/v0/discover", headers: { host: `evil.example:${bound.port}` } });
  assert.equal(rebound.status, 403);
  assert.equal(rebound.body.code, "ORIGIN_REFUSED");
  for (const host of [`127.0.0.1:${bound.port}`, `localhost:${bound.port}`]) {
    assert.equal((await raw(bound.port, { path: "/mp/v0/discover", headers: { host } })).status, 200, host);
  }
});

test("a body over the limit is refused with 413 before it is read in full", async () => {
  const small = await listen(createHttpServer(new MonitorService(new MemoryStore()), { maxBodyBytes: 1024 }), 0);
  try {
    const big = monitorBody("big", "x".repeat(4096));
    const declared = await raw(small.port, {
      method: "POST", path: "/mp/v0/monitors",
      headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(big)) }, body: big,
    });
    assert.equal(declared.status, 413);
    assert.equal(declared.body.code, "TOO_LARGE");
    const chunked = await raw(small.port, {
      method: "POST", path: "/mp/v0/monitors", headers: { "content-type": "application/json", "transfer-encoding": "chunked" }, body: big,
    });
    assert.equal(chunked.status, 413, "a body that does not declare its length is cut off at the limit too");
    const fits = await raw(small.port, { method: "POST", path: "/mp/v0/monitors", headers: { "content-type": "application/json" }, body: monitorBody("fits") });
    assert.equal(fits.status, 201, "a body under the limit is served");
  } finally {
    await small.close();
  }
});

test("a corrupt state file falls back to the newest good copy, is kept aside for inspection, and fails loudly when nothing is good", () => {
  const dir = mkdtempSync(join(tmpdir(), "mp-state-"));
  const path = join(dir, "state.json");
  const svc = new MonitorService(new MemoryStore(path));
  svc.createMonitor({ id: "kept", name: "k", horizon: "day", capabilities: ["observe"], visibility: "public" });
  svc.createMonitor({ id: "kept-too", name: "k2", horizon: "day", capabilities: ["observe"], visibility: "public" });
  assert.ok(existsSync(`${path}.prev`), "every write keeps the copy it replaces");

  writeFileSync(path, "{ this is not json");
  const recovered = new MemoryStore(path);
  assert.ok(recovered.monitors.has("kept"), "it starts from the previous good copy");
  assert.match(String(recovered.recoveredFrom), /state\.json\.prev$/, "and says which file it used");
  const aside = readdirSync(dir).filter((f) => f.startsWith("state.json.corrupt-"));
  assert.equal(aside.length, 1, "the broken file is kept under a new name, not overwritten");
  assert.equal(readFileSync(join(dir, aside[0]), "utf8"), "{ this is not json");

  const dir2 = mkdtempSync(join(tmpdir(), "mp-state-"));
  const path2 = join(dir2, "state.json");
  writeFileSync(path2, "broken");
  writeFileSync(`${path2}.prev`, "also broken");
  assert.throws(() => new MemoryStore(path2), /state\.json/, "with no good copy it refuses to start, naming the file");
  assert.equal(readFileSync(path2, "utf8"), "broken", "and touches nothing");
});
