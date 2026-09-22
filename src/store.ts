import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Filter } from "./types.js";

/** One row of a monitor's log. Bookkeeping observations live here too, with a protocol `type`. */
export interface LogEvent {
  seq: number; time: string; monitor: string; type: string; subject: string | null; actor: string;
  tier: string; origin: string; verification: string; horizon: string;
  data: Record<string, unknown>; provenance: Record<string, unknown>;
}
export interface MonitorRow {
  id: string; name: string; description: string | null; version: number; owner: string; ownerTokenHash: string;
  /** Ownership established against a registration token rather than declared. A disclosure (P1). */
  attested: boolean;
  /** What a subscriber may be granted without the owner token (P7, P14). */
  defaultGrant: string[];
  /** When set, subscribing requires this token — what `shared` means (P14). */
  subscribeTokenHash: string | null;
  source: Record<string, unknown>; filter: Filter; horizon: string; capabilities: string[];
  cadence: Record<string, unknown>; ttl_seconds: number | null; retire_after_mute_seconds: number | null;
  budget: Record<string, unknown> | null; visibility: string; rules: unknown[]; types: string[];
  created: string; updated: string; active: boolean; paused: boolean; lastSourceContact: string | null;
}
export interface SubscriptionRow {
  id: string; monitor: string; subscriber: string; tokenHash: string; filter: Filter; capabilities: string[];
  cursor: number; deliveredMax: number; delivered: number; protocol: string; sink: string | null;
  reset_policy: string; retire_after_mute_seconds: number | null; created: string; lastPull: string | null; active: boolean;
}
export interface LeaseRow {
  subject: string; holder: string | null; lease_duration_seconds: number; acquire_time: string; renew_time: string;
  expires: string; lease_transitions: number; attempts: number; delivery_count_limit: number; monitor: string;
}

export interface Snapshot { seq: number; floor: number; events: LogEvent[]; monitors: MonitorRow[]; subscriptions: SubscriptionRow[]; leases: LeaseRow[] }

/**
 * In-memory store with optional JSON snapshot persistence. The reference server is deliberately a
 * single writer (Node's event loop): claims are check-and-set without a lock, which is exactly the
 * "one conditional write" the spec asks for. `compact(uptoSeq)` drops old rows and raises the
 * retention floor so CURSOR_EXPIRED (C17) is exercisable.
 *
 * `persist()` is called by `append` and by every service path that changes durable state without
 * appending — committing a cursor, seeking, rotating a token, delivering a batch. A long-poll
 * iteration that delivers nothing writes nothing.
 */
export class MemoryStore extends EventEmitter {
  seq = 0; floor = 0;
  events: LogEvent[] = [];
  /** Highest seq per monitor: `head` is the high-water mark of *its* log, never the server's (P5). */
  private heads = new Map<string, number>();
  monitors = new Map<string, MonitorRow>();
  subscriptions = new Map<string, SubscriptionRow>();
  leases = new Map<string, LeaseRow>();
  constructor(readonly path?: string) {
    super();
    if (path && existsSync(path)) this.load(JSON.parse(readFileSync(path, "utf8")) as Snapshot);
  }
  append(ev: Omit<LogEvent, "seq">): LogEvent {
    const row = { ...ev, seq: ++this.seq };
    this.events.push(row);
    this.heads.set(row.monitor, row.seq);
    this.emit("append", row);
    this.persist();
    return row;
  }
  /** The server's high-water mark. Not what a subscriber is told: see `headOf`. */
  head(): number { return this.seq; }
  /** The monitor's own high-water mark (P5). 0 when it has never emitted. */
  headOf(monitor: string): number { return this.heads.get(monitor) ?? 0; }
  retentionFloor(): number { return this.floor || (this.events[0]?.seq ?? 0); }
  /** Events strictly after `seq`. */
  after(seq: number, limit: number): LogEvent[] { return this.fromSeq(seq + 1, limit); }
  /** Events at or after `seq` — the cursor is the next seq to deliver (spec/04-delivery.md). */
  fromSeq(seq: number, limit: number): LogEvent[] {
    let lo = 0, hi = this.events.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.events[mid].seq >= seq) hi = mid; else lo = mid + 1; }
    return this.events.slice(lo, lo + limit);
  }
  compact(uptoSeq: number): number {
    const before = this.events.length;
    this.events = this.events.filter(e => e.seq > uptoSeq);
    this.floor = Math.max(this.floor, uptoSeq + 1);
    this.persist();
    return before - this.events.length;
  }
  /** Resolve when a row is appended or after `ms`. */
  waitAppend(ms: number): Promise<boolean> {
    return new Promise(res => {
      const t = setTimeout(() => { this.off("append", h); res(false); }, ms);
      const h = () => { clearTimeout(t); res(true); };
      this.once("append", h);
    });
  }
  snapshot(): Snapshot {
    return { seq: this.seq, floor: this.floor, events: this.events, monitors: [...this.monitors.values()],
      subscriptions: [...this.subscriptions.values()], leases: [...this.leases.values()] };
  }
  load(s: Snapshot): void {
    this.seq = s.seq; this.floor = s.floor ?? 0; this.events = s.events ?? [];
    this.heads = new Map();
    for (const e of this.events) this.heads.set(e.monitor, e.seq);
    this.monitors = new Map((s.monitors ?? []).map(m => [m.id, m]));
    this.subscriptions = new Map((s.subscriptions ?? []).map(x => [x.id, x]));
    this.leases = new Map((s.leases ?? []).map(l => [l.subject, l]));
  }
  persist(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.snapshot()));
    renameSync(tmp, this.path);
  }
}
