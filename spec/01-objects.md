# 01 — Objects

Five objects. Names are working names (vendor prefix `ai.mentu`, to be renamed by the owner).
Every timestamp is RFC 3339 UTC. Every identifier that crosses a boundary is a URI-reference.
All vocabularies in this file are closed and validated on write (P11).

## 1. Monitor — a definition (what is watched, at what rhythm, with what authority)

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | URI-ref | yes | Stable identity matching `[\w.-]{2,64}`; becomes the CloudEvents `source` of every observation it emits (`monitor:<id>` in the reference server). Never changes. |
| `name`, `description`, `version` | string | yes / no / yes | A2A `AgentCard` names reused; `version` is the definition version, bumped on `update`. |
| `owner` | URI-ref (actor) | yes | `human:` · `agent:` · `system:` · `hook:` prefix, as Mentu/Atrio actors. |
| `source` | object | yes | `{kind, ref, settings}`; `kind` ∈ `shell` · `ws` · `http` · `file` · `feed` · `cir` · `formula`. `ref` is what is watched (command, URL, path, another monitor's `id`, a CIR query, a recipe name). |
| `filter` | Filter | no | What the monitor keeps from its source (§6). Empty = everything. |
| `horizon` | enum | yes | `event` · `minute` · `hour` · `day` · `week` · `month`. Authority attribute (P8). |
| `capabilities` | [enum] | yes | `observe` · `react` · `act`. What the monitor's own reactions may do. |
| `cadence` | object | no | `{heartbeat_seconds}` or `{schedule}` (5-field cron, UTC) or `{event_driven: true}`. |
| `ttl_seconds` | int | no | Freshness of an observation for state purposes (MCP `ttlMs` idea, in seconds to match cadence). |
| `retire_after_mute_seconds` | int | no | Default 604800 (168 h). Subscriptions that do not pull within it are retired (P6). |
| `budget` | object | no | `{currency, per_day}`. Enforced by the server; a monitor over budget pauses and says so. |
| `visibility` | enum | yes | `private` (default) · `shared` · `public` (P14). |
| `rules` | [Rule] | no | `{id, version, when: Filter, then: Action, derived_from: [URI-ref], reason}`; `Action` ∈ `log` · `annotate` · `label` · `escalate:<subscription>` · `run:<ref>` · `notify:human` — mechanical only (P9). Every reaction records `rule.id@version`. |
| `types` | [string] | no | Observation `type`s this monitor declares it emits (reverse-DNS). |
| `limits` | object | no | NIP-11 names where meaning matches: `max_subscriptions`, `max_limit`, `default_limit`, `retention_seconds`, `auth_required`. |
| `created`, `updated` | timestamp | yes | |
| `active` | bool | yes | `false` when paused or retired; `state.live` says which. |
| `head` | int | yes | High-water `seq` of its log (read-only). |

A Monitor is also an actor: it appears in `actors` and can be a `subscriber` of other monitors.

## 2. Observation — one event, as a CloudEvent

An Observation **is** a CloudEvents 1.0 event in JSON format (`specversion: "1.0"`). Core
attributes are used with their CloudEvents meaning; the protocol adds extension attributes, all
lowercase, ≤ 20 chars, scalar (CloudEvents extension rules).

| Attribute | CE | Req | Meaning here |
|---|---|---|---|
| `id` | core | yes | Unique with `source`; the dedup key. Implementations MAY use the decimal `seq`. |
| `source` | core | yes | The Monitor `id`. |
| `type` | core | yes | Reverse-DNS. Protocol-defined types are under `ai.mentu.monitor.` (§5); implementation kinds keep their own prefix (Atrio: `ai.mentu.atrio.entrada.creada`). |
| `subject` | core | no | What the observation is about (Atrio `genesis`; a file path; a URL). |
| `time` | core | yes | When observed. |
| `datacontenttype`, `dataschema` | core | no | `application/json` unless stated; `dataschema` points at the implementation's payload schema. |
| `data` / `data_base64` | core | yes | The payload plus `provenance` (below). Mutually exclusive, per CE. |
| `sequence` | CE ext | yes | Per-`source` ordering: the integer `seq` zero-padded to 20 digits so string comparison equals integer comparison; comparable only within one `source` (CE rule). |
| `tier` | ext | yes | `src` · `measured` · `derived` · `unverified` · `falsified` (the `[SRC]` ladder, lowercase for CE). |
| `origin` | ext | yes | `human` · `agent` · `webhook` · `probe` · `system`. |
| `verified` | ext | yes | Verification level as string: `human_verified` · `machine_verified` · `certified` · `reported` · `unverified` (Mentu's `trust.verification` literals). |
| `horizon` | ext | yes | Copied from the Monitor at emit time. |
| `actor` | ext | yes | URI-ref of who caused it. |
| `redelivered` | ext | no | Boolean; set by the server on redelivery after an uncommitted pull. |
| `traceparent`, `tracestate` | CE ext | no | W3C trace context, as CloudEvents defines. |

`data.provenance` (structured, because CE extensions cannot hold maps): `{origin, tier,
verification, actor, source_ref, rule, wasDerivedFrom: [{source, id}], wasAttributedTo: actor,
supersedes: {source, id}}` — PROV-DM relation names.

Rules: an `agent`-origin observation MUST NOT carry `tier: src` (P1, `TIER_NOT_ASSERTABLE`). A
rejected input is emitted as an observation of type `ai.mentu.monitor.rejected` with the raw
payload in `data.raw` (P2). Observations are append-only; a correction is a new observation with
`data.provenance.supersedes` (P13).

## 3. State — the computed projection

Served by `monitors/state` and also emitted as an Observation of type `ai.mentu.monitor.state`
(replaceable: the latest per `source` is the current one, Nostr's replaceable-event rule).

| Field | Type | Meaning |
|---|---|---|
| `monitor` | URI-ref | |
| `as_of`, `as_of_seq` | timestamp, int | When computed and the last `seq` included. |
| `covers_until` | timestamp | The last moment the underlying source was actually observed (not when the state was computed). |
| `head`, `retention_floor` | int | Highest `seq`; lowest `seq` still retained (below it, `CURSOR_EXPIRED`). |
| `live` | `{value: bool, reason}` | `false` with a reason: `paused` · `retired` · `over_budget` · `source_unreachable` · `mute_since:<ts>` · `circuit_open`. |
| `counters` | object | `observations`, `delivered`, `acted`, `subscriptions_active`, `rejected`. |
| `last` | `{seq, time, type}` | |
| `ages` | object | Seconds since last observation, since last pull by any subscriber, since last successful source contact. Ages, not counts. |
| `contradictions_open` | int | Observations of type `…contradiction` without a `…resolved` successor. |
| `confidence` | object | `{value: number|null, computed_by, inputs: {present: [], missing: []}, gaps: []}`. A missing input is listed, never defaulted (P3). `gaps` are strings from a closed list: `no_event_provenance` · `independence_unknown` · `single_actor` · `stale_source` · `no_subscribers`. |
| `computed_from` | `{seq_from, seq_to}` | PROV `wasDerivedFrom` over a range. |
| `ttl_ms` | int | Freshness hint for caches (MCP naming). |
| `supersedes` | `{source, id}` | The previous state observation. |

## 4. Subscription — a consumer with a durable cursor

| Field | Type | Req | Notes |
|---|---|---|---|
| `id` | string | yes | Server-minted, durable across reconnects (neither CE-Subscriptions, Nostr nor MCP has one; we need it). |
| `monitor` | URI-ref | yes | One subscription, one monitor. Fan-in is the subscriber's job. |
| `subscriber` | URI-ref (actor) | yes | Person, agent session (`agent:<name>@<session8>`), or another Monitor. |
| `filter` | Filter | no | Narrows; never renumbers. The cursor is the monitor's `seq`. |
| `capabilities` | [enum] | yes | Subset of what the grant allows: `observe` · `react` · `act`. Enforced with `CAPABILITY_MISSING` (P7). |
| `cursor` | int | yes | Committed position = next `seq` to deliver (Kafka *committed position*). |
| `reset_policy` | enum | no | `earliest` · `latest` · `none` (Kafka `auto.offset.reset` names) — what happens on `CURSOR_EXPIRED`. Default `none`: the subscriber must relist. |
| `protocol` | enum | yes | `pull` (default) · `http` (push, Standard Webhooks headers) · `mcp` (wake-up through `subscriptions/listen`, delivery by pull). |
| `sink`, `sinkcredential` | URI, object | for `http` | CE-Subscriptions names. |
| `retire_after_mute_seconds` | int | no | Overrides the monitor's. |
| `created`, `last_pull`, `active`, `lag` | | | `lag = head − cursor`. |

The bearer token is returned once at creation and stored hashed. Re-creating with the same
`(monitor, subscriber)` renews the token and keeps the cursor.

**Lease** (on `act`): `{subject, holder: subscription.id, lease_duration_seconds, acquire_time,
renew_time, lease_transitions, attempts, delivery_count_limit}` — Kubernetes Lease field names;
expiry rule `now > renew_time + lease_duration_seconds`; Kafka share-group vocabulary for the
outcomes: `release` (back to the queue), `reject` (dead-letter after `delivery_count_limit`),
`complete`.

## 5. Configure — mutation as evidence

There is no Configure object. Every mutation of a Monitor or Subscription emits an Observation:

| `type` | When |
|---|---|
| `ai.mentu.monitor.configured` | create · update · pause · resume · retire of a Monitor. `data`: `{action, before_digest, after: Monitor, diff, rule, reason, actor}`. |
| `ai.mentu.monitor.subscribed` | Subscription created or renewed. `data`: `{subscription, filter, capabilities, cursor}` (no token). |
| `ai.mentu.monitor.subscription_retired` | By request or by the mute sweep. `data`: `{subscription, reason, cursor, mute_since}` — the *will* event. |
| `ai.mentu.monitor.lease` | `claim` · `renew` · `complete` · `release` · `reject` · `expired`. |
| `ai.mentu.monitor.state` | A state snapshot (replaceable). |
| `ai.mentu.monitor.bookmark` | Closes the initial-events replay after a relist (K8s `initial-events-end`). |
| `ai.mentu.monitor.rejected` | Any refused input (P2). |
| `ai.mentu.monitor.contradiction` / `…contradiction_resolved` | Two observations about one `subject` that a rule marks as opposing; and its resolution with a reason. |

`pause` suspends activations and keeps leases until they expire; `retire` releases leases. Neither
is "stop this run" (P10).

## 6. Filter — the grammar (Nostr-shaped)

```json
{ "types": ["ai.mentu.atrio.entrada.*"], "sources": [], "subjects": [], "actors": [],
  "tiers": ["measured","src"], "origins": [], "horizons": [], "since": "2026-09-21T00:00:00Z",
  "until": null, "limit": 50, "text": "timeout", "#label": ["gate"], "#space": ["checkout"] }
```

- Keys AND; values within an array OR; an array of filter objects OR (NIP-01).
- `types` accepts a trailing `*` as prefix match. `#<key>` matches `data.tags[<key>]`
  (implementations map their own fields; Atrio: `#space`, `#status`, `#label`, `#assignee`).
- `since`/`until` bound `time`; `limit` caps a pull; `text` is a lowercase substring over
  `subject` and `data`.
- Unknown key → `INVALID_FILTER` with `known_keys`; a `types` value that is neither a declared
  type nor a valid prefix → `INVALID_FILTER` with `known_types` (P11).
- Lossless mapping to CloudEvents Subscriptions dialects: `types:[a,b]` ≡ `any:[exact:{type:a},
  exact:{type:b}]`; prefix ≡ `prefix:{type:…}`; `sources`/`subjects` likewise. `since`, `until`,
  `#tags` and `text` have no CE dialect; a CE-Subscriptions bridge carries them in the `sql`
  dialect or refuses.
