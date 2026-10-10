# Server implementations and session adapters

These are two different integration points:

- A **server implementation** stores the protocol's objects and enforces its HTTP or MCP contract.
- A **session adapter** delivers a subscriber's notification into a tool a person is already using.
  The server, monitor, and subscription do not depend on which tool that is.

## Session delivery

| Client | Delivery path | Support boundary |
|---|---|---|
| Codex native runtime preview | In-process Rust/Tokio task with guarded idle admission | [Pinned source patch](../integrations/codex-native/README.md); rebuilt runtime, exact subscribed frontend ownership, operator-registered sources |
| Codex terminal | `bridge run --adapter codex` uses the live process's native `queue` | macOS/Linux terminal binding and a detected queue capability; an existing human-opened session only |
| Claude Code Monitor | Runs the generic `watch` CLI in its Monitor tool | The host owns the Monitor lifecycle; the session handles output and explicitly acknowledges it |
| Other providers and clients | HTTP/MCP pull, or a separately implemented session adapter | Pull is available; automatic wake is not implied by MCP support |

The [session bridge guide](../docs/session-bridge.md) defines the lifecycle, durable receipts, and
adapter boundary. These are consumer features above the existing protocol; they add no wire
methods and do not change conformance semantics.

## Server implementations

Two implementations exist today. Both are measured by the same suite, and each has taught the
specification something the other did not.

The results below are historical, from the 2026-09-21 suite with 30 checks. The current suite
covers C01–C34. The 0.2.0 release updated the Python runner, not Atrio's Python runtime; do not
read the earlier results as a claim that runtime passes the expanded suite.

| Implementation | Language | Result | Notes |
|---|---|---|---|
| Reference server in this package (`monitor-protocol serve`) | TypeScript | **30 PASS · 0 FAIL · 0 SKIP** (`conform --self`) | in-memory log with JSON snapshots, single writer, `--allow-admin` mints an admin token and exposes compaction so cursor expiry can be exercised |
| Atrio's monitor bus | Python 3 (stdlib, SQLite) | **29 PASS · 0 FAIL · 1 SKIP** | a work hub whose bus predates the protocol; the façade presents its existing log through `/mp/v0`. C17 skips: it retains everything |

Both runners are maintained in step, and both servers were written here: they are two readings of
one specification, not two independent ones. What running both buys is that a change has to satisfy
two codebases with different storage, and on 2026-09-21 that is exactly how seven fixes were
checked. Treat agreement between them as a regression gate, not as independent confirmation —
when they shared a blind spot, they shared it silently until an audit probed the inputs neither
check sent.

```bash
python3 conformance/python/run.py --base http://127.0.0.1:8130 --subjects s-a,s-b,s-c --admin-token <tok>
# Reports results for the current checkout; record the suite version and commit with them.
```

## What the second implementation taught the spec

- **A shared log sequence with gaps per monitor is legitimate.** Atrio's `seq` is global and a
  monitor's observations are a subsequence of it. The spec therefore asks for a `sequence` that is
  strictly increasing within one `source`, never dense.
- **Retention may be infinite.** An implementation that never drops an observation cannot reach
  `CURSOR_EXPIRED`, so the suite records `SKIP` with the reason instead of passing the check.
- **Second-resolution clocks change the timing contract.** Where timestamps are truncated to whole
  seconds, a one-second lease or mute threshold needs ≥ 2.5 s to be decided; the reference server
  keeps milliseconds and needs 1.3 s. The same defect appeared in the reference server and is what
  made the rule explicit (`docs/decisions.md`).
- **Monitor and Subscription have to be separate objects.** Atrio's bus held the definition and its
  single consumer in one row, so a second consumer of the same monitor was impossible to express.

## Writing another one

Implement the REST binding in `spec/02-methods.md`, then run both runners. An implementation is
conformant to the current v0 suite when C01–C34 pass, with a `SKIP` allowed only where the check is genuinely not
exercisable and the reason is stated. Report the result as a table with the date, the suite
version and the commit tested.
