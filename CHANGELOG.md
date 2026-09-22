# Changelog

## v0.1.0

Released 2026-09-21.

- First public cut of the Monitor Protocol: fourteen principles, five objects (Monitor,
  Observation as a CloudEvents 1.0 event, State, Subscription, Configure as observations), the
  method set with a REST binding and JSON-RPC, delivery semantics named after their sources
  (Kafka committed position, Kubernetes Lease and `410` relist, MQTT retained state), and the
  conformance suite C01–C21 in two runners (TypeScript, Python).
- Reference server: in-memory store with JSON snapshot persistence, single writer, `--allow-admin`
  compaction for exercising `CURSOR_EXPIRED`.
- Doors: REST + JSON-RPC + SSE (`node:http`, no dependencies); MCP extension `ai.mentu/monitors`
  with tools, `monitor://` resources and `resources/updated` wake-ups; `watch` loop for the Claude
  Code Monitor tool; `tools --json` inspector.
- Extracted from a running implementation (the Atrio bus) whose scars became the principles.
