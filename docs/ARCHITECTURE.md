# Monitor Protocol architecture

The protocol is an epistemic layer over pub/sub. It does not invent transport, envelope, filter or
delivery; it adopts them and owns the objects and the rules that make an observation *evidence*.

## Boundary

| Adopted, unchanged | Owned here |
|---|---|
| CloudEvents 1.0 envelope, JSON format and HTTP binding | the extension attributes `tier`, `origin`, `verified`, `horizon`, `actor`, and what they mean |
| MCP as a client door (extension `ai.mentu/monitors`) | which tools and resources an AI client gets, and that a wake-up is never a delivery |
| Nostr NIP-01 filter shape | filter keys for provenance and horizon, and the rule that an unknown key is an error |
| Kafka committed position, Kubernetes watch and Lease, MQTT retained state | cursor never backwards, ack after processing, state-as-projection, mute retirement |
| W3C PROV-DM relation names | the tier ladder a machine cannot inflate |

Everything the protocol owns is in `spec/00-principles.md` (P1–P14) and `spec/01-objects.md`.

## The five objects

```text
  Monitor ──emits──► Observation ──folded into──► State
     ▲                    │                         │
     │                 pulled by                 read by
  Configure          Subscription ──leases──► exclusive work
  (itself an
   observation)
```

- **Monitor** is a definition: what is watched, at what rhythm (`horizon`), with what authority.
- **Observation** is one CloudEvent carrying provenance; the log of a monitor is append-only.
- **State** is computed from observations, never written by hand, and lists its own gaps.
- **Subscription** is a consumer with a durable cursor, its own filter and its own capabilities.
- **Configure** is not an object: creating, updating, pausing and retiring all emit observations.

## Runtime flow

```text
producer ──publish──► append to log (seq) ─────────────────────────────────┐
                                    │                                       │
                        wake-ups (best effort)                        state projection
                     MCP resources/updated · SSE frame                (computed on read)
                                    │                                       │
                                    ▼                                       ▼
 subscriber ── pull(cursor) ──► observations ──process──► ack(cursor) ──► monitors/state
                                    │
                                    └── leases/claim → complete | release | reject
```

The cursor is the guarantee and the wake-up is a convenience. A subscriber that loses every
notification still loses nothing: it pulls, processes, acks. A subscriber that acks before
processing is the only way to lose an observation, which is why `pull` never commits.

## Three doors, one service

`MonitorService` holds every rule and knows nothing about transport. Each door maps onto it:

| Door | For | Notes |
|---|---|---|
| REST + JSON-RPC (`/mp/v0`) | scripts, other services, the Python conformance runner | `node:http` only, no dependencies |
| SSE (`/subscriptions/{id}/stream`) | browsers and long-lived readers | `id:` is the seq, `Last-Event-ID` resumes, heartbeat every 5 s; only `ack` commits |
| MCP extension `ai.mentu/monitors` | AI hosts | tools plus `monitor://{id}/definition` and `monitor://{id}/state`; `resources/updated` is the wake-up |
| `watch` loop | a Claude Code Monitor arm | prints one line per observation and acks after printing |

The installed MCP SDK has no `extensions` field on server capabilities, so the extension id
currently travels under `experimental`; the name is the one the spec fixes.

## Single writer

The reference server is one process with an in-memory log and optional JSON snapshots. A claim is
one check-and-set on the event loop, which is exactly the "one conditional write" the spec asks
for. "Kafka-shaped" here describes the semantics, never the throughput. An implementation that
needs concurrency must keep the same guarantees: monotonic sequence, atomic claim, ack that never
moves backwards.

## What this is not

- **Not a pub/sub replacement.** If you need fan-out at volume, put a broker underneath and make
  this the epistemic layer above it.
- **Not a scheduler.** A monitor declares a cadence; running things on time is the host's job.
- **Not an inference engine.** The daemon evaluates mechanical rules. Judgment happens in a
  subscribed session, which may be a person or an agent a person is running (P9).
- **Not a second source of truth.** Where a system already owns a record, the monitor observes it
  and cites it; it does not re-own it.
