# Shared workspace and Construct status

`monitor-protocol workspace status --config FILE` produces a read-only JSON snapshot.
Add `--html` for a standalone page linking to the Construct. It starts no model, source,
subscription, or consumer and makes no acknowledgement. A host can call the exported
`workspaceStatus` and `renderWorkspaceStatus` functions for a fresh view on each request.

```json
{
  "version": 1,
  "workspace": "Shared engineering",
  "construct": { "id": "engineering", "url": "http://127.0.0.1:8350/c/engineering" },
  "sourceHealthFile": "/private/operator-state/source-health.json",
  "staleAfterMs": 30000,
  "participants": [
    { "actor": "agent:codex@engineering", "mode": "attended-session", "handlingWithinMs": 300000 },
    { "actor": "agent:claude@engineering", "mode": "attended-session" }
  ]
}
```

Paths are trusted local host configuration, never values supplied by an observation.
An optional participant `bridgeState` points to that participant's private `BridgeJournal`.
The operator owns this actor-to-journal mapping. The view does not grant identity or authority.
Serve it only within the intended workspace access boundary; do not publish local state.

## Distinct evidence

| Field | Meaning |
| --- | --- |
| Source state | The source worker's last report, plus independent heartbeat/success freshness checks |
| Transport | Status of a configured bridge worker, or explicitly unconfigured/unavailable |
| Delivery phase | Pending, queued, handled, or no pending delivery in that journal |
| Handling expectation | Age of the original delivery, optional deadline, and whether a matching handling receipt exists |
| Capability readiness | `verified` only when a retained receipt passes integrity, profile, binding and freshness checks now, against a binding the host obtained live in the same call (`liveBinding`); otherwise `unverified`, `binding-unavailable`, `binding-mismatch`, `expired` or `evidence-invalid` |
| Native wake | `unverified`; a running source or queue cannot establish this |

An actor appears because the operator configured it. Appearing in the view does not mean
the actor has an active monitor. A stale source can still report its last state as healthy;
`ready` becomes false as soon as either heartbeat or successful read is outside the allowed age.
The source file is local host evidence, not a signed process attestation.

## An independent check for missed handling

Set `handlingWithinMs` on a participant to state how long the operator expects a
delivery to wait for a handling receipt. Values range from 1,000 to 86,400,000 ms.
The interval starts at the journal's original `Delivery.created`. Enqueue, repeated
delivery, worker restart, and refreshed heartbeats do not reset it. Omit the field
when the operator has not set an expectation; the view must not invent a deadline.

The `handling` projection separates these observations:

| State | What the observer can establish |
|---|---|
| `unobserved` | The journal is absent or unconfigured; no conclusion about pending work |
| `no-pending-delivery` | This journal has no pending delivery; upstream work may still exist |
| `awaiting-handling` | A delivery has no handling receipt; no configured deadline has passed |
| `handling-overdue` | The configured deadline has been reached without a matching handling receipt |
| `handled-awaiting-ack` | The journal has a matching receipt; the consumer still owns acknowledgement |
| `evidence-invalid` | Journal or timing evidence is unreadable, malformed, or inconsistent |

The observer reads the journal without consuming events or changing its bytes. It
does not acknowledge, relaunch, reassign, or retry work. A healthy worker can have
overdue handling. A receipt ends the handling alert but does not establish that a
ticket was verified, accepted, or closed. Source freshness, transport health, tool
readiness, and native wake retain their separate meanings.

Run this check from a host that can observe the participant independently. A view
that stops with the participant cannot report that participant's disappearance.
The returned `observedAt` dates the snapshot; consumers must apply their own freshness
limit before presenting a saved snapshot as current. This package does not start
an observer daemon or promise continued observation after the caller exits.

This handling deadline is an additive local projection field. It changes no Monitor
Protocol wire object and supplies no work authorization or claim lease.

Source adapters write a v1 health object containing `status` (`starting`, `healthy`,
`retrying`, `failed`, `stopped`), `terminal`, `checked_at`, `last_success`,
`worker_heartbeat_at`, and nonnegative `failure_count`. Times are UTC ISO strings or null.
Missing/malformed files, future timestamps and expired evidence never make a source ready.
Arbitrary source fields, credentials, paths and diagnostic messages are omitted from the view.

The local Construct adapter additionally keeps MP HTTP available during transient source-read
failures, retries with capped backoff, and latches invalid bindings/digests until reviewed.
That adapter remains a local integration; this package supplies the public projection contract.

## Tool parity

The [capability admission API](tool-capabilities.md) verifies the required MCP tool set through
the actual session before work. A historical successful probe cannot make a new runtime ready.
This view deliberately does not accept an arbitrary saved receipt as current readiness.
Hosts must integrate live bindings, expiry and tool-provider ownership before exposing that status.

From a source checkout, run the isolated no-inference Codex fixture:

```bash
npm run build
node examples/codex-capability-trial.mjs \
  --codex /absolute/path/to/codex \
  --state /absolute/path/to/a/new/private/trial
```

It creates an isolated configuration and ephemeral thread in its own App Server, discovers
the required MCP tool, calls it through that thread, checks the result, admits one no-op,
refuses a missing required tool, and stops its owned runtime. It needs no model call or copied
login. The retained `result.json` proves dispatch capability at that time; it does not prove
model tool selection, desktop permissions, idle wake, or full Codex app equivalence.

## Tool readiness from a live binding

A participant may name `capability: { profileFile, receiptFile }`, both absolute paths: the
provider-resolved profile and the receipt that preflight issued against it. The command line
cannot bind another session, so it always reports such a participant as `unverified`. A host
that embeds `workspaceStatus(config, now, { liveBinding })` supplies a function that obtains
the participant's binding live, in that call, or returns null. Only then can the view report
`verified`, with `capabilityExpiresAt`. A saved receipt alone, a binding from an earlier call,
or a Claude probe observation never makes a participant ready, and tool readiness never
implies native wake.

