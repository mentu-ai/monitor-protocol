import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const entry = resolve(import.meta.dirname, "..", "index.js");

test("importing the library does not run the CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "mp-lib-"));
  const script = join(dir, "use.mjs");
  writeFileSync(script, `import { MonitorService, MemoryStore } from ${JSON.stringify(entry)};\n` +
    `const s = new MonitorService(new MemoryStore());\nconsole.log("OK", s.store.head());\n`);
  const out = execFileSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(out.trim(), "OK 0");
  assert.doesNotMatch(out, /epistemic layer over pub\/sub/, "the CLI usage leaked into a library import");
});

test("the CLI still runs when it is the entry point", () => {
  const version = execFileSync(process.execPath, [entry, "--version"], { encoding: "utf8" }).trim();
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const tools = JSON.parse(execFileSync(process.execPath, [entry, "tools", "--json"], { encoding: "utf8" })) as { tools: { name: string }[] };
  assert.ok(tools.tools.length >= 12);
});
