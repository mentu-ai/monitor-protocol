# Session bridge

The Monitor Protocol supplies the shared service: observations, provenance, subscriptions, and
durable cursors. A session bridge supplies delivery into a particular tool. A workspace can use
several tools without changing its monitors or making one provider's session the workspace.

The bridge in this checkout is a consumer of the existing protocol. It adds no wire methods or
objects. It is not included in the published 0.2.0 package.

## Capability matrix

| Host | Read observations | Wake a live conversation | Session boundary |
|---|---|---|---|
| Codex terminal with a native `queue` capability | HTTP subscription through the bridge | The Codex adapter queues a reference into the bound session | Discovers its own live terminal ancestor and thread; never starts or resumes a session |
| Claude Code with its Monitor tool | `watch` CLI or MCP | The host's Monitor tool delivers output | The host owns the Monitor lifetime and rearming |
| Other MCP clients | MCP tools | Depends on the host; no generic wake guarantee | Use an implemented host adapter or attended pull |
| HTTP clients and ordinary terminals | HTTP or `watch` CLI | No model wake supplied by the transport | Pull, handle, and explicitly acknowledge |

The Codex adapter supports macOS and Linux process inspection. Windows is refused. It checks
the executable of the running Codex process for the required `queue --thread --message`
capability; finding an executable named `codex` on `PATH` is insufficient. A host version without
that capability uses the pull workflow.

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

A normal exit releases the directory's `worker.lock`. A forced kill can leave that lock behind;
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
