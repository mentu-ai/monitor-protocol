import type { Filter, Observation } from "./types.js";
import { HORIZONS, ORIGINS, TIERS } from "./vocab.js";

export const FILTER_KEYS = new Set(["types", "sources", "subjects", "actors", "tiers", "origins", "horizons",
  "since", "until", "limit", "text"]);
const LIST_KEYS = new Set(["types", "sources", "subjects", "actors", "tiers", "origins", "horizons"]);

const asList = (v: unknown): string[] => v == null ? [] : Array.isArray(v) ? v.map(String) : [String(v)];

export interface FilterValidation { ok: boolean; problems: string[]; known_keys: string[]; known_types?: string[] }

/** Unknown key or undeclared type → INVALID_FILTER (P11). `knownTypes` omitted = types not checked. */
export function validateFilter(f: unknown, knownTypes?: string[]): FilterValidation {
  const known_keys = [...FILTER_KEYS].sort().concat(["#<tag>"]);
  if (f == null) return { ok: true, problems: [], known_keys, known_types: knownTypes };
  if (typeof f !== "object" || Array.isArray(f)) return { ok: false, problems: ["filter must be an object"], known_keys, known_types: knownTypes };
  const problems: string[] = [];
  for (const k of Object.keys(f)) if (!FILTER_KEYS.has(k) && !/^#[A-Za-z_][\w-]*$/.test(k)) problems.push(k);
  const o = f as Record<string, unknown>;
  if (knownTypes) for (const v of asList(o.types)) {
    const ok = v.endsWith("*") ? knownTypes.some(t => t.startsWith(v.slice(0, -1))) : knownTypes.includes(v);
    if (!ok) problems.push(`types:${v}`);
  }
  for (const v of asList(o.tiers)) if (!(TIERS as readonly string[]).includes(v)) problems.push(`tiers:${v}`);
  for (const v of asList(o.origins)) if (!(ORIGINS as readonly string[]).includes(v)) problems.push(`origins:${v}`);
  for (const v of asList(o.horizons)) if (!(HORIZONS as readonly string[]).includes(v)) problems.push(`horizons:${v}`);
  if (o.limit != null && (!Number.isInteger(Number(o.limit)) || Number(o.limit) < 1)) problems.push("limit");
  return { ok: problems.length === 0, problems, known_keys, known_types: knownTypes };
}

/** Inline narrows, never widens: list keys intersect; an empty intersection names the key. */
export function intersectFilters(stored: Filter, inline: Filter): { filter: Filter | null; clash?: string } {
  const out: Record<string, unknown> = { ...(stored as Record<string, unknown>) };
  for (const [k, v] of Object.entries(inline as Record<string, unknown>)) {
    if (v == null) continue;
    if (k === "since") out.since = [out.since ?? "", String(v)].sort().pop();
    else if (k === "until") out.until = [out.until ?? "￿", String(v)].sort()[0];
    else if (k === "limit") out.limit = Math.min(Number(out.limit ?? Number.MAX_SAFE_INTEGER), Number(v));
    else if (k === "text") out.text = out.text ? `${out.text} ${v}` : String(v);
    else {
      const want = new Set(asList(v));
      const have = asList(out[k]);
      if (have.length) {
        const both = have.filter(x => want.has(x));
        if (!both.length) return { filter: null, clash: k };
        out[k] = both.sort();
      } else out[k] = [...want].sort();
    }
  }
  return { filter: out as Filter };
}

/** AND across keys, OR within arrays; trailing `*` on a type is a prefix. */
export function matches(f: Filter | undefined, ce: Observation): boolean {
  if (!f || !Object.keys(f).length) return true;
  const o = f as Record<string, unknown>;
  const types = asList(o.types);
  if (types.length && !types.some(w => ce.type === w || (w.endsWith("*") && ce.type.startsWith(w.slice(0, -1))))) return false;
  const attr: [string, keyof Observation][] = [["sources", "source"], ["subjects", "subject"], ["actors", "actor"],
    ["tiers", "tier"], ["origins", "origin"], ["horizons", "horizon"]];
  for (const [k, a] of attr) { const want = asList(o[k]); if (want.length && !want.includes(String(ce[a] ?? ""))) return false; }
  if (o.since && ce.time < String(o.since)) return false;
  if (o.until && ce.time > String(o.until)) return false;
  const tags = (ce.data?.tags ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) if (k.startsWith("#")) {
    const have = tags[k.slice(1)];
    const set = new Set(Array.isArray(have) ? have.map(String) : [String(have)]);
    if (!asList(v).some(x => set.has(x))) return false;
  }
  if (o.text) {
    const hay = (JSON.stringify(ce.data ?? {}) + " " + (ce.subject ?? "")).toLowerCase();
    if (!hay.includes(String(o.text).toLowerCase())) return false;
  }
  return true;
}
