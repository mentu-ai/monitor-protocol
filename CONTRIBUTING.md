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
npm test          # unit, HTTP, MCP and conformance suites (node --test)
npm run conform   # the package against itself, C01–C21
npm run typecheck
```

## Changing the spec

The spec is the product; code follows it. A change to `spec/` needs, in the same pull request:

1. the reason and the source it is adopted from, as a row in `docs/decisions.md` (append-only);
2. the conformance check that would fail without the change, in `spec/05-conformance.md` and both
   runners (`src/conformance.ts`, `conformance/python/run.py`);
3. the schema in `schemas/` when an object changes.

Vocabularies are closed; a new value is a spec change, never a silent pass.

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
src/watch.ts     Claude Code Monitor client loop
src/conformance.ts  C01–C21 runner
src/index.ts     CLI and public API
```

## Inbound contribution license

By submitting a contribution you agree it is licensed under the Apache License 2.0 that covers
this repository, and that you have the right to license it so.
