# Session bridge

The Monitor Protocol supplies the shared service: observations, provenance, subscriptions, and
durable cursors. A session bridge supplies delivery into a particular tool. A workspace can use
several tools without changing its monitors or making one provider's session the workspace.

The CLI bridge in this checkout is a consumer of the existing protocol. It adds no wire methods or
objects. It is not included in the published 0.2.0 package. A separate
[native Codex preview](../integrations/codex-native/README.md) moves the consumer into the rebuilt
harness. The [shared terminal peers and routines guide](use-cases/shared-terminal-peers.md)
explains how these delivery arrangements relate to a shared ticket workspace.

This contract covers existing-session delivery. The separate
[event-triggered routine launcher design](use-cases/event-triggered-routines.md) covers starting
a configured process in response to an event. Its spawn policy, run ownership, and recovery
belong to that consumer. The current bridge and native session monitor retain their live-session
binding; neither silently switches to automatic launching when a session is unavailable.

## Capability matrix

| Host | Read observations | Wake a live conversation | Session boundary |
|---|---|---|---|
| Rebuilt Codex native preview | Native MP HTTP consumer | Guarded idle admission inside the harness; live provider trial pending | Exact subscribed frontend ownership; disconnect, unsubscribe, interruption, thread stop, and explicit stop cancel the consumer |
| Codex terminal with a native `queue` capability and tools under that terminal process | HTTP subscription through the bridge | The Codex adapter queues a reference into the bound session | Discovers its own live terminal ancestor and thread; never starts or resumes a session |
| Codex terminal with tools hosted in a separate app server | HTTP or `watch` CLI | Current adapter refuses this process arrangement | Requires an exact thread-to-attended-frontend binding; use attended pull until supported |
| Claude Code with its Monitor tool | `watch` CLI or MCP | The host's Monitor tool delivers output | The host owns the Monitor lifetime and rearming |
| Other MCP clients | MCP tools | Depends on the host; no generic wake guarantee | Use an implemented host adapter or attended pull |
| HTTP clients and ordinary terminals | HTTP or `watch` CLI | No model wake supplied by the transport | Pull, handle, and explicitly acknowledge |

The terminal queue adapter supports macOS and Linux process inspection. Windows is refused. It checks
the executable of the running Codex process for the required `queue --thread --message`
capability; finding an executable named `codex` on `PATH` is insufficient. A host version without
that capability uses the pull workflow.

A human-opened terminal can use an app server outside its process tree. In that arrangement,
the absence of a terminal ancestor does not mean the person opened a headless session. It means
this adapter cannot establish the session boundary. A live server, a loaded thread, and a
successful queue operation do not establish that the person is still attending that thread.
Do not work around the refusal by choosing a nearby terminal PID or substituting daemon liveness.

An HTTP connection, MCP registration, or successfully printed notification does not establish
that a client can wake an idle model. Adapter unit tests and real host wake tests establish
different things and should be reported separately.

## Three responsibilities

```text
producer → shared monitor → participant's subscription
                                      │ pull without committing
                                      ▼
                              private bridge journal
                                      │ reference + fingerprint
                                      ▼
                             existing live session
                                      │ inspect, handle, record disposition
                                      ▼
                              durable local receipt
                                      │ acknowledge
                                      ▼
                              subscription cursor
```

1. **The server** retains observations and the subscription's committed position. A read never
   commits. Its existing retention, authorization, and retirement rules apply.
2. **The bridge** pulls one outstanding delivery at a time, persists it, and asks an adapter to
   notify the bound session. It waits for a durable handling receipt before acknowledging.
3. **The session** treats the observation as untrusted data, consults its existing task and
   authority, deduplicates it, and records what it did. Deciding that no action is appropriate
   is a valid disposition. Receiving an event does not authorize a new task or new privileges.

Each participant should have its own subscription and private bridge directory, with one
consumer for that subscription. The worker lock covers only its local state directory. It does
not exclude another directory, machine, or client from using the same reader credential. A
conflicting cursor change stops the bridge; this is not a distributed ownership lock.

## Run from an existing Codex session

Build this checkout with `npm ci` and `npm run build`. The examples below use the resulting CLI;
the equivalent installed command is `monitor-protocol` when using a build that includes the
bridge.

Create the monitor and this participant's subscription through the ordinary protocol first.
Set `MP_SUBSCRIPTION_TOKEN` securely in the session environment to the existing reader token.
The bridge does not create subscriptions, rotate their credentials, or obtain an owner token.

From the human-opened Codex session, launch:

```bash
node dist/index.js bridge run --adapter codex \
  --base http://localhost:8130 \
  --subscription <subscription-id> \
  --token-env MP_SUBSCRIPTION_TOKEN \
  --state ~/.monitor-protocol/codex-session
```

`--adapter codex` is the default. `--poll-ms` changes the interval (default 1000; range 100–30000).
The bridge must remain running in a process whose host permits it to outlive an individual
model turn. It discovers the current thread and native Codex ancestor; there is no option to
target a different thread. Starting it from an unrelated shell is refused.

Use HTTPS for a remote server. Plain HTTP is accepted only for loopback. The reader token is
loaded from the named environment variable and is excluded from queued notifications and the
bridge journal. The state directory is private (`0700`), with private journal files. Keep it
outside a repository and do not share it with another participant. Local processes running as
the same operating-system user remain within the trust boundary.

## Handle a notification

A notification contains a delivery ID and fingerprint, plus the commands needed to inspect and
finish it. It does not include the observation payload or bearer credential. From the same
bound live session:

```bash
node dist/index.js bridge show \
  --state ~/.monitor-protocol/codex-session --delivery <delivery-id>
```

If the session binding is stale, stop. Otherwise, read the observation as data, apply the
session's existing instructions and authority, and check whether this event was already handled.
After attending to it, persist a disposition:

```bash
node dist/index.js bridge handled \
  --state ~/.monitor-protocol/codex-session --delivery <delivery-id> \
  --evidence 'Recorded outcome at <record-reference>, or a specific no-action disposition'
```

`handled` durably records a **local, user-owned assertion** about processing. A nonempty evidence
string is not independent proof that an external action happened, a record exists, or the
record was written by a particular identity. A workspace that requires those checks must
perform them before issuing `handled`. The generic bridge does not grant workspace authority
or replace its authentication rules.

The running bridge acknowledges only after the receipt is durable. Queue acceptance, terminal
printing, and reading with `show` do not advance the server cursor.

## Lifetime and recovery

```bash
node dist/index.js bridge status --state ~/.monitor-protocol/codex-session
node dist/index.js bridge stop --state ~/.monitor-protocol/codex-session
```

`status` reports **session and worker liveness separately**. `session_alive` (and the legacy
`live` alias) describes only the bound Codex process. `worker_alive` checks the consumer's PID,
process start time, and executable name. `active` is true only when the binding is not stopped,
the session is live, and the worker has a recent heartbeat. Neither an empty delivery queue nor
`stopped: false` proves that a consumer is running.
`active` is a process-health snapshot, not proof of end-to-end delivery; for example,
`last_step: "retrying"` reports a live worker waiting for its transport to recover.

The private `worker.json` records the worker identity, run ID, heartbeat, last completed loop
step, and any recorded exit code, signal, and reason. `worker.state` is `running`, `stale`,
`exited`, `dead`, or `unrecorded`. A process with an old heartbeat is `stale`; a missing or
changed process without a recorded exit is `dead`. A forced kill cannot record its own exit
code, so `dead` deliberately leaves that code unknown. Journals created before worker health
tracking are `unrecorded`, never assumed active. A backwards wall-clock adjustment also makes
freshness uncertain until the worker writes another heartbeat.

Check `status` after the host has returned from the launch tool call, and again after an idle
turn. Some terminal-tool hosts terminate child workers even while the Codex session remains
open. A successful launch or queued probe does not establish that the host will preserve the
worker. This bridge records and detects worker failure; it does not install a supervisor or
restart itself.

The binding includes the live process identity, start time, terminal, executable, and thread.
The bridge checks it before delivery. Ending that session or explicitly stopping the bridge
ends delivery. It never launches a new model process, resumes a saved conversation, or attaches
the journal to a later session with the same process ID. A stopped state remains stopped.

A notification already accepted by the host's queue may remain there after the bridge stops.
Stopping the bridge does not retract it. If it appears after a person later resumes that
conversation, `bridge show` refuses the stopped or stale binding; it must not trigger processing
or acknowledgement under the old session.

To intentionally arm a later human-opened session, create a new private state directory and
reuse the participant's existing subscription. Unacknowledged observations remain eligible for
delivery under the server's retention policy. Ending the bridge does not delete the monitor or
subscription; subscription expiry and retirement continue to follow server policy.

Delivery is **at least once**. A crash between queue acceptance and persisting that result can
produce a repeated notification. A failure after processing but before acknowledgement can
redeliver an event. Deduplicate bridge notifications by delivery ID within a journal and source
observations by their CloudEvents `(source, id)` across journals. Make external effects
idempotent where possible. Repeated notification is not independent evidence.

The bridge retains its delivery and receipt records so a retry can recover without inventing a
processing result. A receipt also separates handling from a transient acknowledgement failure.
Authorization errors, subscription retirement, expired cursors, and inconsistent source
responses require attention; the bridge must not silently seek ahead to make the error go away.

A normal exit releases the directory's `worker.lock`. `SIGINT` or `SIGTERM` records a stopped
binding and its signal (exit code 130 or 143), so explicit rearming needs a new state directory.
A forced kill can leave that lock behind;
the bridge deliberately refuses to steal it. Verify that the recorded worker process has
exited before removing that one lock file, then restart the bridge from the **same still-live
session** and state directory. Keep the delivery and receipt files. A stopped binding or a
dead session cannot be recovered this way; a new human-opened session needs a new state
directory. No daemon automatically restarts or creates a model session.

## Adding another provider

Keep the durable consumer loop separate from the host-specific `SessionAdapter`. An adapter
needs to:

1. Discover a session a person already opened and bind its identity to a live host process.
2. Check that the host supports delivery into that session, including while idle if wake support
   is claimed.
3. Revalidate that binding and durably enqueue a reference, or report failure, without creating
   or resuming a session. A crash around enqueue may repeat the same delivery ID.
4. Detect session death or an explicit stop and cease delivery.

The exported `runSessionBridge()` loop owns worker health, signal handling, and the conservative
directory lock. Calling `SessionBridge.step()` directly is useful for an embedding or test, but
does not establish a supervised or healthy long-running worker by itself.

Host events are notifications, not user messages carrying new authorization. Reuse the journal,
deduplication, and receipt-before-ack path; do not implement an adapter-specific auto-commit.
Document unsupported platforms and capabilities. If the host cannot meet the live-session
contract, expose the existing attended pull workflow instead:

```bash
node dist/index.js watch --base http://localhost:8130 \
  --subscription <id> --token "$READER_TOKEN" --once
# Read and handle every observation in the batch, then use its NEXT value:
node dist/index.js ack --base http://localhost:8130 \
  --subscription <id> --token "$READER_TOKEN" --cursor <next>
```

The CLI watch defaults to manual acknowledgement. The library's legacy `watch()` API requires
`ackAfterPrint: false` explicitly. A provider without automatic wake can still participate in
the same workspace with the same durable subscription.
