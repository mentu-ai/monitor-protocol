# 05 — Conformance

A conformant implementation passes every check in `conformance/run.py` against its REST binding.
Each check names the principle or the incident it comes from. Checks are black-box: the suite
knows only the base URL and creates its own monitor and subscriptions.

| Id | Check | From |
|---|---|---|
| C01 | `GET /mp/v0/discover` returns `supportedVersions`, `capabilities`, `serverInfo`, `ttlMs` | MCP discover shape |
| C02 | A filter with an unknown key is refused `400 INVALID_FILTER` with `known_keys` | P11, Atrio §3 |
| C03 | A `types` value that is neither declared nor a valid prefix is refused with `known_types` | P11, Atrio §21 (`entrada.enlazada`) |
| C04 | An `agent`-origin write asserting `tier: src` is refused `400 TIER_NOT_ASSERTABLE` | P1 |
| C05 | `feeds/pull` does not advance the cursor; a second pull returns the same observations | P4 |
| C06 | `feeds/ack` below the stored cursor is `409 CURSOR_BACKWARDS`; equal is a no-op with the same result | P4, Atrio §21 |
| C07 | `head` after a narrow filter equals the unfiltered head | P5 |
| C08 | Inline pull filter narrows and never widens: a widening query is refused or intersected | Atrio §4 defect found 2026-09-21 |
| C09 | Every observation is a valid CloudEvent (`specversion`, `id`, `source`, `type`, `time`) with `sequence`, `tier`, `origin`, `verified`, `horizon`, `actor` | 01 §2 |
| C10 | `sequence` is zero-padded to 20 digits and strictly increasing within a source | CE `sequence` |
| C11 | A subscription without `act` calling `leases/claim` gets `403 CAPABILITY_MISSING` | P7 |
| C12 | Two concurrent `leases/claim` on one subject: exactly one wins, the other gets `409 LEASE_HELD` naming the holder | Atrio §6 positive control |
| C13 | `leases/complete` after the lease expired and another holder claimed is `409 LEASE_LOST` | Atrio §6 |
| C14 | `monitors/pause`, `resume`, `retire` and `feeds/retire` each emit the corresponding `ai.mentu.monitor.*` observation, and a publish while paused is refused `409 UNAVAILABLE` and accepted again after resume | P10; Atrio silent `retire` defect |
| C15 | `monitors/state` carries `as_of`, `covers_until`, `live{value,reason}`, `confidence{inputs{present,missing},gaps}`; a missing input is listed in `missing`, never defaulted | P3 |
| C16 | A rejected input (bad signature or invalid vocabulary) is visible as an `ai.mentu.monitor.rejected` observation | P2 |
| C17 | A pull with `cursor` below `retention_floor` is `410 CURSOR_EXPIRED` with `retention_floor` and `relist` | 04 |
| C18 | A private monitor is absent from `monitors/list` without its bearer and present with it | P14 |
| C19 | A subscription mute past `retire_after_mute_seconds` is retired and `…subscription_retired` is emitted; re-subscribing keeps the cursor | P6 |
| C20 | Re-sending an identical `ack` or `claim` returns the prior result | 04 idempotence |
| C21 | Corrections: a superseding observation carries `data.provenance.supersedes` and the original is unchanged | P13 |
| C20b | Re-claiming a lease the subscription already holds returns the same lease, not a conflict | 04 idempotence |
| C22 | After an ack computed from the spec's own definition of the cursor, the acked observations do not come back | P4 |
| C23 | A wrong bearer, and no bearer, are both `401` on an authenticated endpoint | P7 |
| C24 | Positive control: a lease claimed by the holder completes successfully | suite rigor |
| C25 | A subscription caught up reports `lag: 0`, and an unrelated monitor publishing moves neither its `lag` nor its `head` | P5 |
| C26 | The provenance ceiling holds for every inflation the earlier checks do not send: tier without origin, tier with a declared human origin, a human origin from a non-human actor, an agent self-certifying, an agent naming a person the monitor does not belong to; a person's observation with no tier or verification stated stops below `src` and `human_verified`; and its positive control holds: an agent naming the monitor's human owner in `on_behalf_of` reaches the owner's level, with both names kept | P1 |
| C27 | A cursor that is not an integer is refused, in `ack` and in the pull replay | P3, P11 |
| C28 | A stranger cannot be granted `act` by asking for it | P7 |
| C30 | A request carrying an `Origin` the server does not allow is refused `403 ORIGIN_REFUSED`; the same request without an `Origin` is served | 03 §HTTP |
| C29 | Every object the run received — monitor, subscription, observation, state, lease, error — validates against its schema in `schemas/` | 01 §normative schemas |

## Runners

Two runners, same ids and same assertions:

```bash
monitor-protocol conform --base http://127.0.0.1:8130 [--admin] [--json]   # TypeScript, in this package
monitor-protocol conform --self                                            # the reference server against itself
python3 conformance/python/run.py --base http://127.0.0.1:8124 --subjects a,b,c   # language-independent
```

C17 needs the log to have a retention floor above the oldest observation. A server that can be
compacted exposes that under `--allow-admin` (`POST /mp/v0/admin/compact {upto_seq}`), and the
runner uses it when `--admin` is passed; an implementation that retains everything records the
check as `SKIP` with the reason rather than passing it. Because compaction is destructive, it runs
last. Timing: a one-second lease or mute threshold is checked after 1.3 s against a server with
millisecond clocks; a server whose timestamps are truncated to whole seconds needs ≥ 2.5 s.

Passing C01–C30 (C20b included) = **conformant v0**. Thirty-one checks; `SKIP` is allowed for C17 on a
server that retains everything, and for C29 only in a runner that cannot read the schemas — the
Python runner ships a subset validator so that it can.

Every negative check above owes a positive control, and the ones added on 2026-09-21 exist because
a mutation experiment showed the suite passing servers that broke the rule the check is named
after: a server that stored the cursor and ignored it, a server with no authentication at all, and
a server whose observations carried values outside the vocabularies. A suite that cannot fail a
wrong implementation is decorative. An implementation reports its result as a table in its own
docs with the run date, the suite version and the commit tested.
