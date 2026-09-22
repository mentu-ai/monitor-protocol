/**
 * The Claude Code Monitor client loop (spec/03-bindings.md): one line per observation on stdout,
 * ack after the line is printed. `--catch-up` prints the backlog first and acks nothing.
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

export async function watch(opts: WatchOptions): Promise<void> {
  const out = opts.out ?? ((l: string) => console.log(l));
  const client = new MonitorClient(opts.base);
  const wait = opts.wait ?? 25;
  const limit = opts.limit ?? 50;
  const ack = opts.ackAfterPrint !== false;

  if (opts.catchUpFirst) {
    const r = await client.pull<PullResult>(opts.subscription, opts.token, { wait: 0, limit: 200 });
    if (r.status === 200) for (const o of r.body.observations) out(line(o, "CATCHUP "));
    else out(`CATCHUP-ERROR ${JSON.stringify(r.body)}`);
  }

  for (;;) {
    const r = await client.pull<PullResult>(opts.subscription, opts.token, { wait, limit });
    if (r.status === 410) {
      const b = r.body as unknown as { retention_floor: number };
      out(`EXPIRED retention_floor=${b.retention_floor}`);
      const mon = (r.body as unknown as { monitor?: string }).monitor;
      if (mon) {
        const s = await client.state<State>(mon, opts.token);
        if (s.status === 200) out(`STATE monitor=${s.body.monitor} live=${s.body.live.value} reason=${s.body.live.reason ?? "-"} head=${s.body.head} gaps=${s.body.confidence.gaps.join(",")}`);
      }
      await client.seek(opts.subscription, opts.token, b.retention_floor, "cursor expired; relisted from state");
      if (opts.once) return;
      continue;
    }
    if (r.status === 404) { out("RETIRED"); return; }
    if (r.status >= 400) { out(`ERROR ${r.status} ${JSON.stringify(r.body)}`); if (opts.once) return; await new Promise(res => setTimeout(res, 2000)); continue; }
    const page = r.body;
    for (const o of page.observations) out(line(o, "OBS "));
    if (page.observations.length && ack) await client.ack(opts.subscription, opts.token, page.next);
    if (!page.observations.length && wait >= 20) out(`HEAD ${page.head} LAG ${page.lag}`);
    if (opts.once) return;
  }
}
