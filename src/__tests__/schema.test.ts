import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadSchemas, SchemaSet } from "../schema.js";

const DIR = join(import.meta.dirname, "..", "..", "schemas");
const SUPPORTED = new Set(["$schema", "$id", "title", "description", "type", "properties", "required",
  "additionalProperties", "patternProperties", "propertyNames", "items", "enum", "const", "pattern", "format",
  "minimum", "maximum", "minItems", "maxItems", "uniqueItems", "anyOf", "oneOf", "allOf", "$ref", "default", "examples"]);

function keywords(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) { for (const n of node) keywords(n, out); return out; }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "properties" || k === "patternProperties") { for (const sub of Object.values(v as object)) keywords(sub, out); continue; }
      out.add(k);
      keywords(v, out);
    }
  }
  return out;
}

test("every shipped schema loads and every $ref resolves", () => {
  const set = loadSchemas(DIR);
  assert.deepEqual(set.names(), ["error", "filter", "lease", "monitor", "observation", "state", "subscription"]);
  const refs: string[] = [];
  for (const f of readdirSync(DIR)) {
    const raw = readFileSync(join(DIR, f), "utf8");
    for (const m of raw.matchAll(/"\$ref"\s*:\s*"([^"]+)"/g)) refs.push(m[1]);
  }
  assert.ok(refs.length > 0, "no $ref in the schemas; this test would prove nothing");
  for (const ref of refs) {
    const problems = new SchemaSet(DIR).validate("filter", {});
    assert.equal(problems.length, 0, `resolving ${ref} left ${JSON.stringify(problems)}`);
  }
});

test("the validator refuses a keyword it does not implement, rather than passing it", () => {
  const set = loadSchemas(DIR);
  // every keyword actually used by the shipped schemas must be one the validator implements
  const used = new Set<string>();
  for (const f of readdirSync(DIR)) keywords(JSON.parse(readFileSync(join(DIR, f), "utf8")), used);
  const unsupported = [...used].filter(k => !SUPPORTED.has(k));
  assert.deepEqual(unsupported, [], `schemas use keywords the validator does not implement: ${unsupported.join(", ")}`);
});

test("the schemas reject what the prose forbids", () => {
  const s = loadSchemas(DIR);
  assert.notEqual(s.validate("filter", { typo: ["x"] }).length, 0, "an unknown filter key must fail");
  assert.notEqual(s.validate("filter", { tiers: ["banana"] }).length, 0, "a value outside a closed vocabulary must fail");
  assert.notEqual(s.validate("monitor", { id: "x" }).length, 0, "a one-character id must fail its pattern");
  assert.notEqual(s.validate("state", { monitor: "m" }).length, 0, "a state missing its required fields must fail");
  assert.notEqual(s.validate("observation", { specversion: "1.0", id: "1", source: "monitor:m", type: "a.b",
    time: "2026-09-22T00:00:00Z", sequence: "00000000000000000001", tier: "measured", origin: "probe",
    verified: "machine_verified", horizon: "minute", actor: "probe:x", data: {} }).length, 0,
    "an observation without provenance must fail");
  assert.equal(s.validate("filter", { types: ["a.b"], "#space": ["x"], since: "2026-01-01T00:00:00Z" }).length, 0);
});
