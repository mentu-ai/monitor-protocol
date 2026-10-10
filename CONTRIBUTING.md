# Contributing to Monitor Protocol

## Development setup

```bash
git clone https://github.com/mentu-ai/monitor-protocol.git
cd monitor-protocol
npm ci
npm run build
```

## Tests

```bash
npm test          # unit, HTTP, MCP, bridge and conformance suites (node --test)
npm run conform   # the package against itself, C01–C34
npm run typecheck
```

## Changing the spec

The spec is the product; code follows it. A change to `spec/` needs, in the same pull request:

1. the reason and the source it is adopted from, as a row in `docs/decisions.md` (append-only);
2. the conformance check that would fail without the change, in `spec/05-conformance.md` and both
   runners (`src/conformance.ts`, `conformance/python/run.py`);
3. the schema in `schemas/` when an object changes.

Vocabularies are closed; a new value is a spec change, never a silent pass.

## Adding a session adapter

The monitor server, subscriptions, and observations belong to the shared protocol. A session
adapter connects an existing participant to that protocol through its host's supported ingress.
Adding one does not require a new protocol object or a provider-specific workspace model.

Follow the [session bridge contract](docs/session-bridge.md). A contribution must state which
host versions and platforms it supports, how it binds to a human-opened live session, and how it
detects that session ending. An MCP connection or a successful queue call alone is not evidence
that a host can wake an idle session.

Tests must cover a stale session binding, explicit stop, duplicate delivery, and failure between
enqueue, handling, and acknowledgement. Notifications must carry references rather than turn an
observation into new user authority. Do not acknowledge before a durable handling receipt, and do
not start or resume a model session to make an adapter appear to work. Include a separately
identified live test when claiming that a host can actually wake from idle; keep credentials,
private observations, and personal session identifiers out of committed fixtures.

If a host cannot accept a notification into an existing session, document the pull workflow.
Server conformance remains a separate gate from adapter compatibility.

## Adding a routine launcher

An event-triggered routine launcher is a separate consumer integration. Follow the
[routine launcher design](docs/use-cases/event-triggered-routines.md). Document the operator's
authorization, configured executable or provider, fresh-versus-resume policy, process ownership,
limits, and lifetime. Include authenticated programmatic invocation and versioned prompt/context
resolution when supplied by the integration. The local peer launcher's foreground-TTY requirement
does not constrain a separate bounded routine CLI. Do not turn the existing-session bridge into
an implicit launcher.

Cover duplicate events, competing consumers, crashes around process creation, uncertain launch
reconciliation, external-effect deduplication, cancellation, and receipt-before-ack. A process
start is not proof of completed work. A live launch test must show that the event caused a new
run without a manual start after that event; report this separately from existing-session wake.
Routine configuration and run journals remain consumer concerns unless a contribution explicitly
proposes a protocol change through the spec process above.

## Project structure

```
spec/            the protocol (00-principles … 05-conformance)
schemas/         JSON Schema 2020-12 per object
src/vocab.ts     closed vocabularies, error codes and their HTTP / JSON-RPC mapping
src/filter.ts    Nostr-shaped filter: validate, intersect (narrow only), match
src/cloudevents.ts  envelope helpers
src/store.ts     in-memory store with snapshot persistence
src/server/core.ts  MonitorService — all semantics, no transport
src/server/http.ts  REST + JSON-RPC + SSE
src/server/mcp.ts   MCP extension door
src/client.ts    HTTP client
src/watch.ts     terminal pull loop, also usable from Claude Code Monitor
src/session/     durable delivery journal and live-session adapters
src/conformance.ts  C01–C34 runner
src/index.ts     CLI and public API
```

## Inbound contribution license

By submitting a contribution you agree it is licensed under the Apache License 2.0 that covers
this repository, and that you have the right to license it so.
