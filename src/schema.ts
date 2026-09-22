/**
 * A JSON Schema 2020-12 validator covering exactly the keywords `schemas/` uses, and **failing
 * closed** on any other: a validator that silently ignores a keyword reports "valid" for a schema
 * it did not understand, which is worse than having none. No dependency — a protocol package
 * should not need a library to describe itself.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SUPPORTED = new Set([
  "$schema", "$id", "title", "description", "type", "properties", "required", "additionalProperties",
  "patternProperties", "propertyNames", "items", "enum", "const", "pattern", "format", "minimum",
  "maximum", "minItems", "maxItems", "uniqueItems", "anyOf", "oneOf", "allOf", "$ref", "default", "examples",
]);
/** Annotation-only in 2020-12: recorded, never enforced. Listed so the fail-closed rule stays honest. */
const ANNOTATION_ONLY = new Set(["$schema", "$id", "title", "description", "format", "default", "examples"]);

export interface SchemaProblem { path: string; message: string }
type Schema = Record<string, unknown>;

export class SchemaSet {
  private readonly byId = new Map<string, Schema>();
  private readonly byName = new Map<string, Schema>();

  constructor(dir: string) {
    for (const f of readdirSync(dir).filter(n => n.endsWith(".json"))) {
      const schema = JSON.parse(readFileSync(join(dir, f), "utf8")) as Schema;
      this.byName.set(f.replace(/\.json$/, ""), schema);
      if (typeof schema.$id === "string") this.byId.set(schema.$id, schema);
    }
  }
  names(): string[] { return [...this.byName.keys()].sort(); }
  get(name: string): Schema | undefined { return this.byName.get(name); }

  /** Empty when the value conforms. Unknown keywords are reported, never skipped. */
  validate(name: string, value: unknown): SchemaProblem[] {
    const schema = this.byName.get(name);
    if (!schema) return [{ path: "", message: `no schema named ${name}` }];
    return this.check(schema, value, "");
  }

  private resolve(ref: string): Schema | undefined {
    return this.byId.get(ref) ?? this.byName.get(ref.replace(/^.*\//, "").replace(/\.json$/, ""));
  }

  private check(schema: Schema, v: unknown, path: string): SchemaProblem[] {
    const p: SchemaProblem[] = [];
    const at = (m: string) => p.push({ path: path || "(root)", message: m });

    for (const k of Object.keys(schema)) if (!SUPPORTED.has(k)) at(`unsupported schema keyword '${k}' — this validator fails closed`);
    if (p.length) return p;

    if (typeof schema.$ref === "string") {
      const target = this.resolve(schema.$ref);
      if (!target) return [{ path, message: `unresolvable $ref ${schema.$ref}` }];
      return this.check(target, v, path);
    }
    if (v === undefined) return p;

    const types = schema.type == null ? null : Array.isArray(schema.type) ? schema.type.map(String) : [String(schema.type)];
    if (types && !types.some(t => typeOk(t, v))) at(`expected ${types.join("|")}, got ${jsonType(v)}`);
    if (schema.const !== undefined && JSON.stringify(v) !== JSON.stringify(schema.const)) at(`must be ${JSON.stringify(schema.const)}`);
    if (Array.isArray(schema.enum) && !schema.enum.some(e => JSON.stringify(e) === JSON.stringify(v))) at(`not in the vocabulary: ${JSON.stringify(v)}`);
    if (typeof schema.pattern === "string" && typeof v === "string" && !new RegExp(schema.pattern).test(v)) at(`does not match ${schema.pattern}`);
    if (typeof schema.minimum === "number" && typeof v === "number" && v < schema.minimum) at(`below minimum ${schema.minimum}`);
    if (typeof schema.maximum === "number" && typeof v === "number" && v > schema.maximum) at(`above maximum ${schema.maximum}`);

    if (Array.isArray(v)) {
      if (typeof schema.minItems === "number" && v.length < schema.minItems) at(`fewer than ${schema.minItems} items`);
      if (typeof schema.maxItems === "number" && v.length > schema.maxItems) at(`more than ${schema.maxItems} items`);
      if (schema.uniqueItems === true && new Set(v.map(x => JSON.stringify(x))).size !== v.length) at("items are not unique");
      if (schema.items && typeof schema.items === "object")
        v.forEach((item, i) => p.push(...this.check(schema.items as Schema, item, `${path}[${i}]`)));
    }

    if (isObject(v)) {
      const props = (schema.properties ?? {}) as Record<string, Schema>;
      for (const r of (schema.required ?? []) as string[]) if (!(r in v)) at(`missing required property '${r}'`);
      for (const [k, sub] of Object.entries(props)) if (k in v) p.push(...this.check(sub, v[k], path ? `${path}.${k}` : k));
      const patterns = Object.entries((schema.patternProperties ?? {}) as Record<string, Schema>);
      for (const [k, val] of Object.entries(v)) {
        if (k in props) continue;
        const hit = patterns.find(([re]) => new RegExp(re).test(k));
        if (hit) { p.push(...this.check(hit[1], val, path ? `${path}.${k}` : k)); continue; }
        if (schema.additionalProperties === false) at(`unexpected property '${k}'`);
      }
    }

    for (const key of ["anyOf", "oneOf"] as const) {
      const branches = schema[key] as Schema[] | undefined;
      if (!Array.isArray(branches)) continue;
      const passing = branches.filter(b => this.check(b, v, path).length === 0).length;
      if (key === "anyOf" && passing === 0) at("matches none of the anyOf branches");
      if (key === "oneOf" && passing !== 1) at(`matches ${passing} of the oneOf branches, expected exactly one`);
    }
    if (Array.isArray(schema.allOf)) for (const b of schema.allOf as Schema[]) p.push(...this.check(b, v, path));
    return p;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const jsonType = (v: unknown): string => v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
function typeOk(t: string, v: unknown): boolean {
  switch (t) {
    case "object": return isObject(v);
    case "array": return Array.isArray(v);
    case "string": return typeof v === "string";
    case "number": return typeof v === "number";
    case "integer": return typeof v === "number" && Number.isInteger(v);
    case "boolean": return typeof v === "boolean";
    case "null": return v === null;
    default: return false;
  }
}

/** The shipped schemas, resolved relative to this module so it works from `dist/` and from source. */
export function loadSchemas(dir?: string): SchemaSet {
  return new SchemaSet(dir ?? join(import.meta.dirname, "..", "schemas"));
}
export { ANNOTATION_ONLY };
