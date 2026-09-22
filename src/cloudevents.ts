import type { Observation } from "./types.js";
import { HORIZONS, ORIGINS, TIERS, TYPE_RE, VERIFICATIONS } from "./vocab.js";

export const CE_BATCH = "application/cloudevents-batch+json";
export const CE_JSON = "application/cloudevents+json";

/** CloudEvents `sequence` extension: zero-padded so string order equals integer order within a source. */
export const seqstr = (seq: number): string => String(seq).padStart(20, "0");
export const seqnum = (s: string): number => Number.parseInt(s, 10);

const REQUIRED = ["specversion", "id", "source", "type", "time", "sequence", "tier", "origin", "verified", "horizon", "actor"] as const;
const IN = (set: readonly string[], v: unknown): boolean => typeof v === "string" && set.includes(v);

/** Structural check of one observation against spec/01-objects.md §2 (C09/C10 shape). */
export function validateObservation(o: unknown): string[] {
  const p: string[] = [];
  if (!o || typeof o !== "object") return ["not an object"];
  const ce = o as Record<string, unknown>;
  for (const k of REQUIRED) if (ce[k] == null) p.push(`missing ${k}`);
  if (ce.specversion !== "1.0") p.push("specversion must be 1.0");
  if (typeof ce.sequence === "string" && !/^\d{20}$/.test(ce.sequence)) p.push("sequence must be 20 digits");
  if (!IN(TIERS, ce.tier)) p.push(`tier not in the vocabulary: ${String(ce.tier)}`);
  if (!IN(ORIGINS, ce.origin)) p.push(`origin not in the vocabulary: ${String(ce.origin)}`);
  if (!IN(VERIFICATIONS, ce.verified)) p.push(`verification not in the vocabulary: ${String(ce.verified)}`);
  if (!IN(HORIZONS, ce.horizon)) p.push(`horizon not in the vocabulary: ${String(ce.horizon)}`);
  if (typeof ce.type !== "string" || !TYPE_RE.test(ce.type)) p.push(`type is not reverse-DNS: ${String(ce.type)}`);
  if (typeof ce.time !== "string" || Number.isNaN(Date.parse(ce.time))) p.push(`time is not a timestamp: ${String(ce.time)}`);
  if (ce.data == null && ce.data_base64 == null) p.push("data or data_base64 required");
  if (ce.data != null && ce.data_base64 != null) p.push("data and data_base64 are mutually exclusive");
  return p;
}

/** Observations are ordered by `sequence` within one `source`; duplicates are equal (source, id). */
export function dedupe(list: Observation[]): Observation[] {
  const seen = new Set<string>();
  return list.filter(o => { const k = o.source + "\u0000" + o.id; if (seen.has(k)) return false; seen.add(k); return true; });
}
