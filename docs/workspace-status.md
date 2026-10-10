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
    { "actor": "agent:codex@engineering", "mode": "attended-session" },
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
| Capability readiness | `unverified` in this v1 projection; no runtime-bound provider is wired to the view yet |
| Native wake | `unverified`; a running source or queue cannot establish this |

An actor appears because the operator configured it. Appearing in the view does not mean
the actor has an active monitor. A stale source can still report its last state as healthy;
`ready` becomes false as soon as either heartbeat or successful read is outside the allowed age.
The source file is local host evidence, not a signed process attestation.

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
