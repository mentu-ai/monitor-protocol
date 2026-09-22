# Changelog

## v0.1.1

Unreleased.

An independent audit of v0.1.0 found that the protocol's one original claim was false in its own
reference implementation, and that a client written from the specification lost data. Both are
fixed, along with five other findings, and the conformance suite now fails a server that breaks
any of them.

- **Provenance.** The top of each ladder — `origin: human`, `tier: src`, `human_verified`,
  `certified` — now requires an **attested** monitor: created against the server's registration
  token and owned by a `human:` principal. `origin` may no longer authorise itself from the request
  body, and an actor prefix is a ceiling (`agent:evil` cannot carry a human origin). New error
  `PROVENANCE_CEILING`; new monitor fields `attested` and `default_grant`.
- **The cursor** is the next `seq` to deliver, inclusive, as the spec and Kafka both define it. The
  implementation moved to meet the spec; `next` is now the last delivered seq plus one.
- **`head` and `lag`** belong to the monitor and to the subscription. Lag is what this subscription
  would receive if it pulled now, its own filter included, so a filtered subscriber reaches zero.
- **A non-integer cursor** is refused instead of becoming `NaN` and silently killing a subscription.
- **Capabilities are granted, not requested.** A subscriber gets the monitor's `default_grant`
  (`observe` by default); more needs the owner token or the subscribe token. `shared` now mints
  that token and is neither listed nor readable without it.
- **The admin endpoints** require an admin token; the snapshot, which carries token hashes, is
  never anonymous. `--allow-admin` mints and prints one.
- **The suite** gains C22–C28 and names C20b: an ack computed from the spec rather than echoed, a
  wrong bearer refused, a positive control for lease completion, per-monitor head and lag, the four
  inflations the old checks never sent, a non-integer cursor, and a stranger refused `act`. The
  observation validator now checks the vocabularies, not merely presence. 29 checks; C17 may skip.
- SSE resumes at `Last-Event-ID` plus one and advances its own cursor, and `--flag=value` parses.

**The schemas are now normative and enforced.** They were documentation that nothing read: seven
files referenced by nothing, and twenty disagreements between prose, schema and types, all of them
live. `schemas/` is now authoritative for the shape of the objects as served, C29 validates every
object a conformance run receives, and the twenty disagreements were reconciled one by one — the
prose moved where the implementation was right, the schemas tightened where the prose was right,
and `live.reason` was cut back to the two values an implementation can actually emit. The validator
is written here rather than pulled in, covers exactly the keywords the schemas use, and **fails
closed** on any other, so a schema can never pass by being misunderstood. `rules` are validated on
write. `DEFAULT_TIER` and `DEFAULT_VERIFICATION` became `ORIGIN_TIER_CEILING` and
`ORIGIN_VERIFICATION_CEILING`, because the old names read as permissions.

Both implementations were moved together: the reference server passes 30 of 30, Atrio 29 with C17
skipped because it retains everything.

## v0.1.0

Repository published 2026-09-21; the npm package was never released, so the fixes above land
before any consumer sees a version.

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
- Five defects found by the conformance suite and by consumer tests against the packed tarball,
  all fixed before this release and recorded in `docs/decisions.md`: whole-second timestamps could
  not decide a one-second deadline; a machine publishing under a human-named owner silently
  obtained the top provenance tier; an SSE stream ended on the request rather than the response;
  a committed cursor did not survive a restart; importing the library ran the CLI.
