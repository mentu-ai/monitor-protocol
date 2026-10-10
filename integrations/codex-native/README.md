# Native Codex monitor preview

This source patch adds a Monitor Protocol consumer inside the Codex harness. A native Rust
task remains attached to the human-opened session between turns and can deliver an observation
when that session is idle. It requires a separately built preview of Codex; applying the patch
does not modify an installed binary or an already running session.

The adapter targets exactly [OpenAI Codex at
`4aa94dce270de668eff6e2fa8585c82385e84455`](https://github.com/openai/codex/tree/4aa94dce270de668eff6e2fa8585c82385e84455).
Its private journal currently supports macOS and Linux. The focused tests pass on
macOS arm64; Linux has not been independently validated. Windows support is not implemented.
This is a Mentu preview fork, not an upstream Codex release or an installable Codex plugin.

## Apply and build

Requirements: Git, Bash, Python 3, Rust **1.95.0**, and the pinned Codex revision's
[build prerequisites](https://github.com/openai/codex/blob/4aa94dce270de668eff6e2fa8585c82385e84455/docs/install.md).
Use a separate checkout. From your local Monitor Protocol repository:

```bash
monitor_bundle="$PWD/integrations/codex-native"
git clone https://github.com/openai/codex.git /path/to/codex-native-preview
git -C /path/to/codex-native-preview checkout --detach 4aa94dce270de668eff6e2fa8585c82385e84455
"$monitor_bundle/apply.sh" /path/to/codex-native-preview
cd /path/to/codex-native-preview/codex-rs
```

`apply.sh` checks the exact HEAD and rejects staged, unstaged, and untracked changes. It
verifies the patch SHA-256 from `manifest.json`, runs `git apply --check`, then applies the
same bytes. It does not fetch, build, stage changes, run a model, or replace a binary. A
manifest with an unset digest is an unfinished bundle and is refused. The digest checks bundle
integrity; obtain the bundle itself from a source you trust.

Run the focused tests and build the CLI:

```bash
export CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0
cargo +1.95.0 test --locked -p codex-monitor-extension --lib
cargo +1.95.0 test --locked -p codex-app-server --test all v2::native_monitor
cargo +1.95.0 test --locked -p codex-core --lib start_guard
cargo +1.95.0 test --locked -p codex-app-server --lib native_monitor::tests
cargo +1.95.0 build --locked -p codex-cli --bin codex
```

The preview passes 45 focused tests: 37 extension tests, four Core admission tests, two
App Server ownership tests, and two App Server integration tests. They exercise the native
task, HTTP source, durable journal, session ownership, and idle admission. The integration
tests run the real App Server with simulated model responses and a local MP server.
A simulated model or accepted input is not a live idle-wake result. Claim a
live result only after a separately identified test through the compiled CLI, with a human
attending the existing session.

The [verification record](verification.json) lists the test commands, cases, and patch digest.
The public patch was applied to a clean checkout of the pinned upstream revision; all 22
resulting files matched the tested source byte for byte.

## Register a source as the operator

Create the participant's subscription on a Monitor Protocol v0 server and provide its reader
bearer token to the launch environment as `MP_READER_TOKEN`. The adapter consumes an existing
subscription; it does not provision credentials or create subscriptions. Give each participant
its own subscription.

Register allowed sources in **`$CODEX_HOME/native-monitors/sources.json`**. When `CODEX_HOME`
is unset, Codex uses `~/.codex`. For example:

```json
{
  "workspace": {
    "base_url": "https://monitor.example.com",
    "subscription": "participant-subscription",
    "token_env": "MP_READER_TOKEN"
  }
}
```

Use HTTPS, or HTTP on loopback for a local server. The base URL may be the server origin or
its `/mp/v0` root. Redirects are refused. Keep the `native-monitors` directory private
(`0700`) and its configuration file private (`0600`). Put the environment variable's name
in the file, never the bearer token. The token is read from the host environment when the
monitor starts and is not written to the journal.

The App Server reads the source allowlist at startup. Changes require a new preview process;
they do not reconfigure an existing session. Only an operator should edit this file: its
entries determine which credential can be sent to which destination. Monitor tools accept
a registered source name and cannot supply a URL, token, token environment name, actor,
thread ID, or client owner.

Once the source and environment are configured, launch the compiled preview yourself:

```bash
./target/debug/codex --no-daemon
```

`--no-daemon` keeps this test attached to the preview's own App Server. Do not replace the
system `codex` executable to try this adapter. If you use `CARGO_TARGET_DIR`, use the built
binary in that directory instead.

## Use the native tools

Ask Codex in that open terminal session to monitor the registered source under the authority
of your existing task. The model's native tools are:

| Tool | Arguments | Effect |
| --- | --- | --- |
| `monitor_status` | `{}` or `{"monitor_id":"…"}` | Lists registered source names and this session's monitor status. |
| `monitor_start` | `{"source":"workspace"}` | Starts or explicitly rearms the native consumer for this session. |
| `monitor_show` | `{"monitor_id":"…","delivery":"…"}` | Reads the delivery as untrusted external context. |
| `monitor_handled` | `{"monitor_id":"…","delivery":"…","evidence":"specific disposition or record reference"}` | Persists a handling receipt after the event was attended. |
| `monitor_stop` | `{"monitor_id":"…"}` | Cancels and joins the native task; retains pending delivery state. |

These are model tools, not shell commands. No shell worker, terminal polling tool, hook
rearm loop, or detached model process is needed. Tools are available only when sources are
registered. A start requires exactly one attending client attached to the thread.

### Delivery and lifetime

- The task lives inside the harness. It does not create, load, or resume another model session.
- An idle session may receive a turn containing delivery references and a fingerprint. A busy
  session retains the event until it can admit that notification; it does not steer an active turn.
- Showing, printing, or enqueueing an observation does not acknowledge it. The model inspects it,
  acts only within existing authority, deduplicates it, then records a specific disposition with
  `monitor_handled`. A reasoned no-action disposition is valid.
- The durable handling receipt permits the source acknowledgement. If the acknowledgement's
  response is lost, it can be retried without presenting the event as new work.
- Explicit stop, interruption, thread stop, client disconnect, and thread unsubscribe cancel the
  native task. Resuming or reconnecting does not automatically restart it.
- An explicit `monitor_start` for the same thread and source can recover the private journal.
  Unhandled delivery IDs and fingerprints survive; an existing handling receipt is acknowledged
  without another wake. A different thread cannot adopt that journal. Use a separate subscription
  for another participant.
- Within one `CODEX_HOME`, a subscription has one native consumer, enforced by a filesystem lock.
  Durable state is kept below `$CODEX_HOME/native-monitors/` with private permissions. This protects against accidental
  cross-session use; it is not an isolation boundary against a process running as the same OS user.

Authentication errors, malformed observations, retention gaps, and conflicting cursor state stop
the consumer with the cursor retained. Transient transport failures retry. Inspect `monitor_status`
and fix the source before explicitly rearming; the adapter does not silently skip a lost range.
An observation remains evidence rather than new user authorization. Handling receipts assert the
session's disposition; they do not prove that an external action occurred.

For the provider-independent contract, see [Session bridges](../../docs/session-bridge.md).

## Attribution and license

This bundle contains changes to **OpenAI Codex, Copyright 2025 OpenAI**, licensed under
[Apache-2.0](https://github.com/openai/codex/blob/4aa94dce270de668eff6e2fa8585c82385e84455/LICENSE).
The upstream source is the exact revision linked above. Preserve its
[NOTICE](https://github.com/openai/codex/blob/4aa94dce270de668eff6e2fa8585c82385e84455/NOTICE)
and other third-party notices when redistributing source or binaries.

Mentu's Monitor Protocol adapter additions and packaging are also covered by this repository's
[Apache-2.0 license](../../LICENSE). The patch identifies the modified and added files; applying
it produces a modified Codex build, not an unmodified OpenAI distribution.

## Cancellation and quiet subscriptions

The final Core admission check rejects a queued wake whose owner or monitor was revoked.
An already admitted turn, or an acknowledgement already received by the remote server,
can finish; cancellation does not roll back either.

Observed events require an actual `monitor_handled` receipt. A validated empty filtered
range uses a separate durable scan receipt and advances without waking the model. It cannot
skip a pending observation. Both receipt types retry acknowledgement after explicit recovery.
The journal retains evidence; compaction for long, high-volume sessions is not implemented.
