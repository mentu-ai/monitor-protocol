/**
 * The Claude Code Monitor client loop (spec/03-bindings.md): one line per observation on stdout,
 * ack after the line is printed. `--catch-up` prints the backlog first and acks nothing. When the
 * server cannot be reached the loop prints DOWN once, backs off and keeps trying, then UP.
 */
import { MonitorClient } from "./client.js";
import type { Observation, PullResult, State } from "./types.js";

export interface WatchOptions {
  base: string; subscription: string; token: string;
  catchUpFirst?: boolean; wait?: number; limit?: number; once?: boolean;
  out?: (line: string) => void; ackAfterPrint?: boolean;
}

const short = (d: unknown): string => { const s = JSON.stringify(d ?? {}); return s.length > 400 ? s.slice(0, 397) + "..." : s; };
const line = (o: Observation, prefix: string): string =>
  `${prefix}seq=${o.id} type=${o.type} subject=${o.subject ?? "-"} tier=${o.tier} origin=${o.origin} actor=${o.actor} redelivered=${o.redelivered === true} data=${short(o.data)}`;

/** Backoff between attempts to reach a server that is not answering, capped so a restart is noticed quickly. */
export const WATCH_RETRY_MS = { first: 1000, max: 10_000 };

export async function watch(opts: WatchOptions): Promise<void> {
  const out = opts.out ?? ((l: string) => console.log(l));
  const client = new MonitorClient(opts.base);
  const wait = opts.wait ?? 25;
  const limit = opts.limit ?? 50;
  const ack = opts.ackAfterPrint !== false;

  // A network failure is not an answer. The server may be restarting, and the subscription's cursor
  // keeps the place, so the watch says so once, waits, and tries again. It never exits for this.
  let down = false;
  let backoff = WATCH_RETRY_MS.first;
  const reach = async <T>(call: () => Promise<T>): Promise<T | null> => {
    try {
      const r = await call();
      if (down) { out("UP the server answers again; resuming from the subscription's cursor"); down = false; backoff = WATCH_RETRY_MS.first; }
      return r;
    } catch (e) {
      if (!down) out(`DOWN ${e instanceof Error ? e.message : String(e)}; retrying, nothing is lost while the server is away`);
      down = true;
      await new Promise(res => setTimeout(res, backoff));
      backoff = Math.min(backoff * 2, WATCH_RETRY_MS.max);
      return null;
    }
  };

  if (opts.catchUpFirst) {
    const r = await reach(() => client.pull<PullResult>(opts.subscription, opts.token, { wait: 0, limit: 200 }));
    if (r && r.status === 200) for (const o of r.body.observations) out(line(o, "CATCHUP "));
    else if (r) out(`CATCHUP-ERROR ${JSON.stringify(r.body)}`);
  }

  for (;;) {
    const r = await reach(() => client.pull<PullResult>(opts.subscription, opts.token, { wait, limit }));
    if (!r) { if (opts.once) return; continue; }
    if (r.status === 410) {
      const b = r.body as unknown as { retention_floor: number };
      out(`EXPIRED retention_floor=${b.retention_floor}`);
      const mon = (r.body as unknown as { monitor?: string }).monitor;
      if (mon) {
        const s = await reach(() => client.state<State>(mon, opts.token));
        if (s && s.status === 200) out(`STATE monitor=${s.body.monitor} live=${s.body.live.value} reason=${s.body.live.reason ?? "-"} head=${s.body.head} gaps=${s.body.confidence.gaps.join(",")}`);
      }
      await reach(() => client.seek(opts.subscription, opts.token, b.retention_floor, "cursor expired; relisted from state"));
      if (opts.once) return;
      continue;
    }
    if (r.status === 404) { out("RETIRED"); return; }
    if (r.status >= 400) { out(`ERROR ${r.status} ${JSON.stringify(r.body)}`); if (opts.once) return; await new Promise(res => setTimeout(res, 2000)); continue; }
    const page = r.body;
    for (const o of page.observations) out(line(o, "OBS "));
    // If the acknowledgement cannot reach the server, the next pull hands the same batch back,
    // marked redelivered: seen twice, never missed.
    if (page.observations.length && ack) await reach(() => client.ack(opts.subscription, opts.token, page.next));
    if (!page.observations.length && wait >= 20) out(`HEAD ${page.head} LAG ${page.lag}`);
    if (opts.once) return;
  }
}
