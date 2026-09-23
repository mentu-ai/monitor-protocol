# Changelog

## Unreleased

- **`watch` keeps going when its server restarts.** A network failure used to end the process
  with `fetch failed`, which is exactly what a Claude Code Monitor meets when the hub restarts. It
  now prints `DOWN` once, waits (1 s, doubling to at most 10 s), tries again, and prints `UP` when
  the server answers. The subscription's cursor keeps the place, so nothing is lost; a batch whose
  acknowledgement could not be sent comes back marked redelivered.
- **Field tests.** `src/__tests__/field.test.ts` starts the server as its own process, kills it
  with SIGKILL and restarts it on the same state file, to test the three promises for real:
  acknowledged writes, tokens and cursors survive; readers keep their own places and filters;
  provenance and refusals stay in the record; the MCP stdio server keeps its monitors. The watch
  restart test failed before the fix above.

## v0.1.2

Released 2026-09-22.

- **A `--state` path that starts with `~` now lands in your home directory.** A shell expands `~`
  before the program sees it, but an MCP client's JSON configuration does not. The MCP example in
  the old README therefore created a folder literally named `~` in whatever directory the client
  started the server from.
- **The README is rewritten in plain language**, from one idea: the Claude Code Monitor tool,
  taken out of the session and made durable, shareable and accountable. It links to the new
  documentation at docs.mentu.ai, including a playground that runs this engine in the browser.
- **A field left out never reaches the top of its ladder.** On a monitor owned by a person, an
  observation with no tier or verification stated now defaults to `measured` and `reported`, as P1
  says, instead of `src` and `human_verified`. Version 0.1.1 had widened that default by accident
  when it made delegation lighter. Asserting `src` explicitly works as before. C26 checks it, in
  both runners, with a raw request the old servers fail.
- The command line help lists the conformance suite as C01 to C29, which is what it runs. MCP
  resource names read `CI: state` instead of using a dash as a separator.

## v0.1.1

Released 2026-09-22, the first version published to npm.

An independent audit of v0.1.0 found that the protocol's one original claim was false in its own
reference implementation, and that a client written from the specification lost data. Both are
fixed, along with five other findings, and the conformance suite now fails a server that breaks
any of them.

- **Provenance.** The top of each ladder, meaning `origin: human`, `tier: src`, `human_verified` and
  `certified`, now requires an **attested** monitor: created against the server's registration
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
- **The suite** gains C22 to C28 and names C20b: an ack computed from the spec rather than echoed, a
  wrong bearer refused, a positive control for lease completion, per-monitor head and lag, the four
  inflations the old checks never sent, a non-integer cursor, and a stranger refused `act`. The
  observation validator now checks the vocabularies, not merely presence. 29 checks; C17 may skip.
- SSE resumes at `Last-Event-ID` plus one and advances its own cursor, and `--flag=value` parses.

**The schemas are now normative and enforced.** They were documentation that nothing read: seven
files referenced by nothing, and twenty disagreements between prose, schema and types, all of them
live. `schemas/` is now authoritative for the shape of the objects as served, C29 validates every
object a conformance run receives, and the twenty disagreements were reconciled one by one: the
prose moved where the implementation was right, the schemas tightened where the prose was right,
and `live.reason` was cut back to the two values an implementation can actually emit. The validator
is written here rather than pulled in, covers exactly the keywords the schemas use, and **fails
closed** on any other, so a schema can never pass by being misunderstood. `rules` are validated on
write. `DEFAULT_TIER` and `DEFAULT_VERIFICATION` became `ORIGIN_TIER_CEILING` and
`ORIGIN_VERIFICATION_CEILING`, because the old names read as permissions.

**An agent acts at the access level of the person it works for.** The first cut of the provenance
gate asked an agent for a credential of its own: a monitor reached the top of the ladder only if it
had been created against a registration token. That is a heavy answer to a question about trust,
and it locked out the ordinary case: a person's own agent, reporting for them. The relationship
that already exists is the monitor: a person owns it and hands its token to their agent. An
observation may now carry `on_behalf_of` naming the monitor's owner, and the agent then works at the
owner's level. It can name nobody else, so delegation lends no one's level. Both names are kept:
`provenance.actor` is who observed, `provenance.on_behalf_of` is who it was for. What the server
refuses is the claim that contradicts itself, not the claim it cannot verify: a machine asserting a
human origin with nobody named, or naming a person the monitor does not belong to. `attested`
stayed, as a disclosure rather than a gate. An unattested server works exactly as well, and every
state it serves carries the gap `unattested_origin` so a reader knows nobody independent vouched for
the owner. C26 gained a fifth probe and its positive control: an agent naming a stranger is refused,
an agent naming the owner is honoured. The MCP `monitor_publish` tool now advertises the field; it
had accepted it silently, which no model would ever have found.

Both implementations were moved together: the reference server passes 30 of 30, Atrio 29 with C17
skipped because it retains everything.

## v0.1.0

Repository published 2026-09-21; the npm package was never released, so the fixes above land
before any consumer sees a version.

- First public cut of the Monitor Protocol: fourteen principles, five objects (Monitor,
  Observation as a CloudEvents 1.0 event, State, Subscription, Configure as observations), the
  method set with a REST binding and JSON-RPC, delivery semantics named after their sources
  (Kafka committed position, Kubernetes Lease and `410` relist, MQTT retained state), and the
  conformance suite C01 to C21 in two runners (TypeScript, Python).
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
