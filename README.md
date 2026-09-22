# Monitor Protocol

[![npm version](https://img.shields.io/npm/v/@mentu/monitor-protocol)](https://www.npmjs.com/package/@mentu/monitor-protocol)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![CI](https://github.com/mentu-ai/monitor-protocol/actions/workflows/ci.yml/badge.svg)](https://github.com/mentu-ai/monitor-protocol/actions/workflows/ci.yml)

**An epistemic layer over pub/sub.** A monitor is an enduring daemon that observes something and
emits *evidence* with provenance. It keeps a computed *state* that says what it knows and what it
does not. People, AI sessions and other monitors *subscribe* with a durable cursor, acknowledge
after processing, and may take exclusive *leases* to act. AI clients can *configure* monitors under
declared capabilities. The daemon never performs inference.

This protocol does not invent transport, envelope, filter or delivery. It adopts them and owns
only the epistemic objects and rules:

| Concern | Adopted from | What this protocol adds |
|---|---|---|
| Event envelope | [CloudEvents 1.0](https://cloudevents.io) JSON + HTTP binding | extension attributes `sequence`, `tier`, `origin`, `verified`, `horizon`, `actor` |
| Door for AI hosts | [MCP](https://modelcontextprotocol.io) 2026-07-28, as extension `ai.mentu/monitors` | tools, `monitor://` resources, best-effort wake-up over `resources/updated` |
| Filter grammar | [Nostr NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) filter object | keys for tier, origin, horizon; `#tag` matching |
| Delivery | Kafka consumer offsets · Kubernetes watch + Lease | cursor never backwards, ack after processing, relist from state when compacted |
| Provenance | W3C PROV-DM terms | a tier ladder a machine cannot inflate |

```text
producers ──publish──► MONITOR log ──► STATE (computed, gaps as properties)
                          │
                          ├── SUBSCRIPTION (cursor, ack, lease) ◄── person / AI session / another monitor
                          └── wake-ups: MCP resources/updated · SSE · Claude Code Monitor arm
```

## Quick start

Requires Node.js 20 or newer.

```bash
npx @mentu/monitor-protocol@latest serve --port 8130 --state ~/.monitor-protocol/state.json
```

Create a monitor, publish an observation, subscribe and pull:

```bash
curl -s localhost:8130/mp/v0/monitors -d '{"id":"ci","name":"CI watch","horizon":"minute","capabilities":["observe","act"],"visibility":"public","types":["com.example.ci.run"]}'
# → {"monitor":{…},"owner_token":"…"}   (shown once)
curl -s localhost:8130/mp/v0/monitors/ci/observations -H "Authorization: Bearer $OWNER" \
  -d '{"type":"com.example.ci.run","subject":"build-412","tier":"measured","origin":"probe","data":{"status":"failed"}}'
curl -s localhost:8130/mp/v0/subscriptions -d '{"monitor":"ci","subscriber":"agent:claude@ab12cd34","capabilities":["observe"]}'
# → {"subscription":{"id":"sub-…","cursor":0},"token":"…"}
curl -s "localhost:8130/mp/v0/subscriptions/sub-…/pull?wait=25" -H "Authorization: Bearer $TOKEN"
curl -s localhost:8130/mp/v0/subscriptions/sub-…/ack -H "Authorization: Bearer $TOKEN" -d '{"cursor":2}'
```

`pull` never advances the cursor; `ack` does, after processing, and never backwards. A pull after a
crash redelivers with `redelivered: true`. That is the guarantee: at-least-once, in Kafka's words.

### From Claude Code

One Monitor arm per session against the hub, instead of one watch per thing:

```
Monitor(command: "npx -y @mentu/monitor-protocol watch --base http://localhost:8130 --subscription sub-… --token $TOKEN --catch-up")
```

The loop prints the backlog first without acking, then one line per observation, acking after
each line. Re-arm at the Monitor tool's 30-minute deadline; the cursor guarantees nothing was lost.

### As an MCP server

```json
{ "mcpServers": { "monitor-protocol": { "command": "npx", "args": ["-y", "@mentu/monitor-protocol@latest", "mcp", "--state", "~/.monitor-protocol/state.json"] } } }
```

Inspect the model-facing surface before configuring a client, exactly as MetaMCP does:

```bash
npx @mentu/monitor-protocol@latest tools
npx @mentu/monitor-protocol@latest tools --json
```

## The rules this protocol owns

Fourteen principles, each paid for by an incident in a running system: [`spec/00-principles.md`](spec/00-principles.md).
The ones people ask about first:

- **A machine cannot assert the top provenance tier.** `origin: agent` with `tier: src` is refused, and the refusal is itself an observation.
- **State says what it does not know.** A confidence with a missing input lists the input as missing; it is never defaulted to a number.
- **Delivery is a queue, not a notification.** Wake-ups (MCP, SSE, a Claude Code Monitor) may be lost; the cursor may not.
- **Registration is not consumption.** A subscription that never pulls is retired, with a will event, and keeps its cursor for when it returns.
- **Authority is an attribute of the horizon.** A minute-level monitor observes and reacts; only a slower process writes beliefs or promotes rules.
- **The daemon never infers.** Judgment happens in a subscribed interactive session.

## Specification

| Part | Content |
|---|---|
| [`spec/00-principles.md`](spec/00-principles.md) | P1–P14 |
| [`spec/01-objects.md`](spec/01-objects.md) | Monitor · Observation (a CloudEvent) · State · Subscription · Configure · the Filter grammar |
| [`spec/02-methods.md`](spec/02-methods.md) | JSON-RPC methods, REST binding, error codes and their HTTP mapping |
| [`spec/03-bindings.md`](spec/03-bindings.md) | CloudEvents, MCP extension, Claude Code Monitor, HTTP push, Nostr relay |
| [`spec/04-delivery.md`](spec/04-delivery.md) | at-least-once, cursor, redelivery, leases, retention, retirement |
| [`spec/05-conformance.md`](spec/05-conformance.md) | C01–C21 and the two runners |
| [`schemas/`](schemas/) | JSON Schema 2020-12 for every object |
| [`docs/prior-art.md`](docs/prior-art.md), [`docs/delivery-semantics.md`](docs/delivery-semantics.md), [`docs/decisions.md`](docs/decisions.md) | why each binding was chosen |

## Conformance

```bash
npx @mentu/monitor-protocol@latest conform --self          # this package against itself
npx @mentu/monitor-protocol@latest conform --base http://127.0.0.1:8124   # any implementation
python3 conformance/python/run.py --base http://127.0.0.1:8124 --subjects a,b,c   # language-independent runner
```

Implementations known to pass: this reference server (21/21), and the Atrio bus (Mentu's work
hub) at 21 PASS · 1 SKIP (infinite retention).

## Library use

```ts
import { MemoryStore, MonitorService, createHttpServer, MonitorClient } from "@mentu/monitor-protocol";
const service = new MonitorService(new MemoryStore("state.json"));
```

## Status

v0.1.0 — first public cut, 2026-09-21. The objects and methods are stable enough to implement
against; the vendor prefix `ai.mentu` and the CloudEvents extension attribute names may still change
before 1.0 and will be listed in `CHANGELOG.md`. Contributions: see `CONTRIBUTING.md`.
