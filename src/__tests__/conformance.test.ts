import assert from "node:assert/strict";
import { test } from "node:test";
import { runConformance } from "../conformance.js";
import { MonitorService } from "../server/core.js";
import { createHttpServer, listen } from "../server/http.js";
import { MemoryStore } from "../store.js";

const EXPECTED = Array.from({ length: 21 }, (_, i) => `C${String(i + 1).padStart(2, "0")}`);

test("the reference server passes every check when compaction can be exercised", async () => {
  const bound = await listen(createHttpServer(new MonitorService(new MemoryStore()), { allowAdmin: true }), 0);
  try {
    const r = await runConformance(bound.url, { admin: true, log: () => undefined });
    assert.equal(r.fail, 0, JSON.stringify(r.results.filter(x => x.status === "FAIL")));
    assert.equal(r.skip, 0);
    assert.ok(r.pass >= 21, `only ${r.pass} passed`);
    for (const id of EXPECTED) assert.ok(r.results.some(x => x.id === id), `missing ${id}`);
  } finally { await bound.close(); }
});

test("without the admin hook the expiry check skips, and says why", async () => {
  const bound = await listen(createHttpServer(new MonitorService(new MemoryStore())), 0);
  try {
    const r = await runConformance(bound.url, { log: () => undefined });
    assert.equal(r.fail, 0, JSON.stringify(r.results.filter(x => x.status === "FAIL")));
    const skipped = r.results.filter(x => x.status === "SKIP");
    assert.deepEqual(skipped.map(x => x.id), ["C17"]);
    assert.match(skipped[0].note, /retains everything/);
  } finally { await bound.close(); }
});
