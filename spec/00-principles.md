# 00 — Principles (the part this protocol owns)

Every rule below was paid for by an incident in a running system and carries the date it was
learned. An implementation that violates one is non-conformant even if every method works.

## P1. The unit of delivery is evidence with provenance, and a machine cannot inflate it

Every observation carries `origin` (`human` | `agent` | `webhook` | `probe` | `system`), `tier`
(`[SRC]` · `[MEASURED]` · `[DERIVED]` · `[UNVERIFIED]` · `[FALSIFIED]`) and `verification`.
Defaults follow origin: webhook and probe → `[MEASURED]`, agent → `[UNVERIFIED]`. An agent that
asserts `[SRC]` is refused (`400`); what an agent proposes enters `[UNVERIFIED]` and only a person
promotes it. *(Atrio §10, 2026-09-15.)*

**A guard may not read its verdict out of the body it is judging.** `origin` arrives in the same
request as the claim it justifies, so it cannot be the thing that authorises the claim. The top of
each ladder — `origin: human`, `tier: [SRC]`, `human_verified` and `certified` — is reachable only
from an **attested** monitor: one created against the server's registration token and owned by a
`human:` principal. An open server still accepts monitors and observations; what it will not do is
let them claim the top. The actor prefix is a ceiling too: `agent:evil` cannot carry a human origin.
*(Independent audit of the reference implementation, 2026-09-21: every inflation the conformance
check did not send was accepted.)*

**The top tier is never reached by defaulting.** Holding a monitor's token is not being a person,
so an observation published without a stated tier tops out at `[MEASURED]` even when the actor
string claims a human origin; `[SRC]` must be asserted explicitly, and the refusal above then
applies to it. *(Found by the reference implementation's own test, 2026-09-21: a machine
publishing under a `human:` owner silently obtained `[SRC]`.)*

## P2. A rejection is still evidence

A webhook whose signature fails, an observation whose vocabulary is invalid, a configure call
the capability does not cover: the raw payload is kept and the refusal is itself an
observation. Nothing is silently dropped, because a dropped event is indistinguishable from
one that never happened. *(Atrio §9.)*

## P3. State is computed and says what it does not know

A monitor's state is a projection over its observations, never hand-written and never edited.
It carries `as_of`, `covers_until`, `live` with a reason, and every gap as a property:
`supports_resolved`, `supports_unresolved`, `independence: "unknown"`, `contradictions_open`.
A confidence with a missing input is reported with the input marked missing, never defaulted:
`?? 0` turns a missing measurement into a confident one. *(Subtrace AGENTS.md, scar 722,
2026-09-11.)*

## P4. Delivery is a queue, not a notification

`feed` does not advance the cursor; `ack` does, after processing, and never backwards. A
subscriber that dies mid-batch receives the same observations again; a subscriber is therefore
idempotent by `seq`. Wake-ups (MCP `subscriptions/listen`, a Claude Code Monitor arm, a
webhook) sit on top of the queue and never replace it: they may be lost, the cursor may not.
*(Atrio §4, §21; MCP 2026-07-28 declares its notifications best-effort.)*

## P5. The head is the real head, and the lag is the real lag

The head a feed reports is the maximum of **that monitor's** log, never of the server's and never
of the filtered slice. A narrow filter must not anchor a subscriber to the last event it cared
about while its lag grows forever. *(Atrio §1.)*

**Lag is what this subscription would receive if it pulled now**, its own filter included — not
arithmetic over a shared counter. A lag computed against a server-wide head counts traffic the
subscriber will never be sent, so it never reaches zero and the natural loop *pull until lag is
zero* does not terminate. *(Measured on the live Atrio board, 2026-09-21: a client caught up on
every event matching its filter reported a lag of 104, and an observer read it as broken.)*

## P6. Registration is not consumption

A subscription that never reads its feed is a dead-letter office. After
`retire_after_mute` (default 168 h) without a feed call the server retires the subscription,
releases its leases and emits `subscription.retired`; re-registering reactivates it with its
cursor intact. A session that works a shared space arms its inbox before it claims anything.
*(Atrio inbox standard, 2026-09-19: 469 undelivered events, both sessions writing, neither
reading.)*

## P7. Capabilities are a contract, enforced by the bus

`observe` reads. `react` annotates and labels. `act` claims with a lease, reports progress,
completes, releases. What was not declared at registration is refused with `403` naming what was
done before the refusal. Hiding a control in a client is not a control. *(Atrio §1, §5.)*

**Capabilities are granted, not requested.** A subscriber receives at most the monitor's
`default_grant` (`observe` unless stated otherwise); its full set requires the owner token or the
subscribe token the monitor was shared with. A bus that hands `act` to whoever asks lets a stranger
take the lease a worker needs. *(Audit, 2026-09-21.)*

## P8. Authority is an attribute of the horizon

Every monitor declares a `horizon` (`event` · `minute` · `hour` · `day` · `week` · `month`). A
faster horizon never writes what a slower one owns: a minute monitor observes and reacts, a day
monitor may write beliefs, only a monthly review promotes rules. Policy descends with lineage
(`derived_from`); evidence rises through subscriptions. *(Horizon essay, 2026-09-20; BUILD
horizons §3.)*

## P9. The daemon never infers

A monitor server evaluates mechanical rules. It does not call a language model. Anything that
needs judgment is delivered to a subscribed interactive session, which may be a person or an
agent the person is running. *(Owner rule, 2026-09-15; MCP 2026-07-28 deprecates sampling for
the same reason.)*

## P10. Configuration is an observation

Creating, updating, pausing or retiring a monitor emits `monitor.configured` with the actor, the
diff and the rule or reason. Pausing a monitor suspends future activations; stopping a run is a
different action on a different object. Six months later the question is not what changed but
which rule changed it. *(Atrio §5 `regla`; Dataware client intent §Scheduled.)*

## P11. Vocabulary is validated on write

`kind`, `tier`, `origin`, `capability`, `horizon` and filter keys and values are checked on
every write and every registration. An unknown value is an error, never a silent pass: a filter
with a typo filters nothing and concludes there is no work, which is worse than an error.
*(Atrio §3, §21.)*

## P12. An inbox filters by addressing, not by ownership

A watcher built to find your work will not find a message about your work. A subscription meant
as an inbox filters on the subscriber's name in the text, not on `assignee == me`. *(Atrio inbox
standard, 2026-09-19.)*

## P13. Nothing is edited; corrections supersede

An observation, a state snapshot, a monitor version: each is append-only. A correction is a new
object with `supersedes` pointing at the old one and a mandatory reason. *(Atrio §14; Subtrace
evidence rules.)*

## P14. Private by default; `shared` means shared with someone; publishing a state does not publish its sources

A monitor is `private` unless declared `shared` or `public`. **`shared` is a grant, not a synonym
for public**: the server mints a subscribe token, and without it a shared monitor is neither listed
nor readable. Sharing is a subscription grant with its own capability set and filter. A state made public exposes counters and confidence
with their gaps; the observations behind it stay under their own visibility. *(Knowledge-as-
interface essay, 2026-09-21.)*
