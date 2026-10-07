# Proposal: a name is not a key, a dead letter stays dead, printing is not handling

**Status:** decided 2026-10-07 and released in 0.2.0. The decision rows are in `docs/decisions.md`.

**Origin:**
- Three defects found in a review of 0.1.3 by a Codex session (gpt-6, 2026-10-06), run in memory
  against the published package and reported to the owner.
- Reproduced here with tests and conformance checks. The lease-scope correction (a subscription
  claims only what its own monitor published) was added after review.

## The problems

All three are reproduced against 0.1.3 (`e7c5225`). The tests in
`src/__tests__/k3-defects.test.ts` and conformance checks C32 and C33 fail there, and pass with the
changes below.

1. **Anyone who knows a subscriber's name can take its subscription.**
   - `feeds/subscribe` with an existing `(monitor, subscriber)` re-keys that subscription, and the
     server does not ask who is calling.
   - On a public monitor, a stranger with no token gets a fresh token for someone else's
     subscription: its id, its cursor, and the leases it holds. The holder's token stops working.
   - The spec says so on purpose ("Re-creating with the same `(monitor, subscriber)` renews the token
     and keeps the cursor", `01-objects.md`), but it never says who may re-create.
   - **Reproduction:** `K3-1`, C32. A token-less re-subscribe as `agent:alice` answers `201` with a
     new token.
2. **A dead letter is only a word in the log.**
   - The `reject` that reaches `delivery_count_limit` emits `…lease{reject, dead_letter: true}`.
   - But nothing in the lease records it. The next claim, by any subscription, succeeds, with
     `attempts: 6` of a limit of 5.
   - **Reproduction:** `K3-2`, C33.
3. **`watch` acknowledges what it has only printed.**
   - The CLI's `watch` acks each batch as soon as it has printed it.
   - A session that dies between reading a line and acting on it loses that event for good: the
     cursor has moved past it.
   - The protocol's own delivery notes say the opposite ("Ack only after side effects complete",
     `docs/delivery-semantics.md`), and so does the Desk Protocol ("acknowledge after handling").
   - The library already had the switch (`ackAfterPrint`); the CLI never used it. The Python runtime
     (`shared-monitor-runtime`) already separates printing from acknowledging.
   - **Reproduction:** `K3-3`. After `watch --once` prints one reading, the next pull finds nothing.

## The corrections

**1. A subscriber's name is not a credential.**
- Re-subscribing an existing subscriber re-keys its subscription, as now: a new token, the same id,
  the same cursor.
- It needs that subscription's current token, or the monitor's owner token for a subscriber that lost
  its own. Anyone else is refused `401 UNAUTHORIZED` (`{subscription, existing: true}`), and the
  holder's token keeps working.
- A monitor's subscribe token admits new subscribers; it does not re-key existing ones.
- The holder keeps the capabilities it was granted before, and cannot widen them without the owner.
- **Text:** `01-objects.md` §Subscription and `02-methods.md` `feeds/subscribe`.

**2. A dead letter is state.**
- The `reject` that reaches `delivery_count_limit` sets `dead_letter: true` on the lease. The field
  is added to the Lease object and to `schemas/lease.json`.
- From then on, any claim on that subject, by anyone, is refused with a new code,
  `409 DEAD_LETTERED {attempts, delivery_count_limit}`. Its JSON-RPC code is `-32018`, the last free
  one below MCP's reserved range.
- Retrying it is a new publication. This matches Kafka (an archived record) and RabbitMQ (the
  dead-letter exchange).
- **Text:** `01-objects.md` §Lease, `02-methods.md` `leases/claim` and the closed list,
  `04-delivery.md` §Attempt cap.

**3. Printing is not handling.**
- `watch` MUST NOT acknowledge what it has only printed. After each batch it prints `NEXT <cursor>`
  and reads on from there without committing (the `cursor` replay `feeds/pull` already has).
- The session acknowledges with a new CLI command, `ack --cursor <n>`, once it has handled the batch.
- A session that dies before handling loses nothing. The next `watch` starts from the last
  acknowledged cursor, and the batch comes back marked `redelivered`.
- `--ack-on-print` keeps 0.1.3's behaviour for consumers that accept the loss window. It is never the
  default.
- **Text:** `03-bindings.md` §Claude Code Monitor tool, README, `docs/ARCHITECTURE.md`.

**4. A subscription claims only what its own monitor published (K3.1).**
- Without this, correction 2 would let any subscription with `act`, on any monitor, dead-letter a
  subject for every monitor.
- The reasons, the rule and its limit are in §Lease scope below.
- **Text:** `01-objects.md` §Lease, `02-methods.md` `leases/claim`, `04-delivery.md` §Attempt cap.

**Conformance:**
- **C32** checks correction 1, **C33** checks correction 2, and **C34** checks correction 4. All
  three are in the TypeScript and Python runners.
- C19 now reactivates the retired subscription with its own token.
- Both runners publish the work items the lease checks use before claiming them.
- "Conformant v0" becomes C01–C30 and C32–C34: thirty-four checks.
- C31 is left free for the acknowledgment and completion work on the `wt-fix` branch.

## Compatibility

These are behaviour changes. Each is listed with whom it affects.

- **Re-subscribing without the token is refused.**
  - This affects a client that kept only its subscriber name and re-subscribed to recover. It must
    keep its token, or ask the owner to re-key.
  - The reference server's C19 and one core test did exactly that; both now present the token.
- **`watch` no longer acknowledges.**
  - A Claude Code Monitor arm that relied on the watch to ack must now run `ack` after handling, or
    pass `--ack-on-print`.
  - The durable watch test now acknowledges through `ack` and keeps its promise: after a restart,
    exactly what arrived in between is printed.
- **A dead-lettered subject stays dead.** A worker that relied on claiming it again must publish it
  anew.
- **A claim needs the subject published by the subscription's own monitor.**
  - A worker that claimed work items its monitor never published, as the conformance runners did
    with `--subjects`, now gets `NOT_FOUND` until that monitor publishes them.
  - The core lease test and both runners now publish first.
- **State from 0.1.x is indexed on load.** The published index is rebuilt from the rows still in the
  log. A subject whose publication was compacted away before the upgrade is no longer claimable; its
  claims answer `NOT_FOUND` until its monitor publishes it again.
- **A new error code.** Clients that switch on the closed list need `DEAD_LETTERED`.
- **Semver.** At 0.x, a breaking change takes the minor version: 0.2.0, not 0.1.4. That is the owner's
  call.

## Evidence

- **Before** (0.1.3, untouched):
  - the five K3 tests fail;
  - the other 54 tests pass;
  - both conformance runners fail exactly C32, C33 and C34, and pass the rest (C17 is skipped when the
    server keeps everything).
- **Before K3.1** (the first version of this patch): K3-4 fails, because a subscription to another
  monitor claimed `job-1`, and so does K3-4b.
- **After:**
  - the full suite passes, 59 of 59;
  - `conform --self` passes;
  - both runners against a served instance pass all 34 checks (C17 skipped, as above).
- The outputs are kept beside the patch that carries this proposal.

## Lease scope: decided as (b)

**Leases are keyed by subject alone, across monitors.**
- The store keys the map by `subject`, and the spec counts "`attempts` per `(subject)`". That is the
  work-item model, Atrio's conditional `UPDATE`.
- In 0.1.3 this already lets one monitor's worker hold a subject that another monitor delivers. That
  interference ends when the lease expires.
- Correction 2 makes a dead letter permanent. So any subscription with `act` on any monitor could
  dead-letter a subject for every monitor, by claiming and rejecting it `delivery_count_limit` times.
  That includes a monitor it created itself on a server without a registration token.

**The options were:**
- **(a)** Scope leases to `(monitor, subject)`. This gives up cross-monitor exclusivity for a shared
  work item.
- **(b)** Let a subscription claim only subjects its own monitor has published. This keeps the
  work-item model and closes the hole, but needs a per-monitor index of subjects.
- **(c)** Accept the risk only where monitors are attested (`--registration-token`).

**Decided: (b).** It is in the patch as correction 4.
- **The rule.** A claim on a subject the subscription's own monitor never published is refused
  `404 NOT_FOUND {subject, monitor}`. The check comes before any other, so a foreign subscription learns
  nothing about who holds the subject.
- **The index.** The server records which monitor published which subject (its own observations,
  never protocol rows). The index is kept apart from the log, so compaction does not forget it. A state
  from before the index is rebuilt from the rows still in its log.
- **Tests and conformance:** K3-4, K3-4b and C34.

**What (b) does not close.** A monitor that publishes the same subject delivers the same work item,
and its subscriptions contend for it. That is the work-item model, kept on purpose. So whoever may
create a monitor may still publish a subject and then hold it or dead-letter it.
- On a server open to untrusted local processes, that is limited only by attested monitors
  (`--registration-token`), option (c).
- Closing it inside the protocol would mean scoping leases per monitor, option (a), or scoping the
  dead letter per monitor. That is a design change for a later version.
- K3-4 states this case explicitly, so the limit is tested, not hidden.

**The same review found three more points, outside this proposal:**
- **One holder per subscription.** Two processes sharing a subscription's token both "hold" its
  leases; there is no fence per worker. Rule: one consumer per cursor.
- **Leases global across monitors.** This is the point above.
- **A repeated `complete` answers `LEASE_LOST`.** It is not idempotent, unlike `claim` (C20b).

## The questions, answered

1. **Re-keying someone else's subscription:** `UNAUTHORIZED`, with no new code.
2. **A dead letter** is retried by publishing it anew. There is no `requeue` method.
3. **The `NEXT <cursor>` line** stays a CLI convention.
4. **The Python runtime** is not changed in this release.
