# 02 — Methods

JSON-RPC 2.0. Requests carry MCP's per-request `_meta` (`…/protocolVersion`, `…/clientInfo`,
`…/clientCapabilities`) so a server is stateless per request; state lives in the store.
Reserved method prefixes (MCP Tasks' pattern): `monitors/`, `feeds/`, `leases/`,
`notifications/monitors/`. We do not use `subscriptions/` (MCP core owns it) or `tasks/`.

| Method | Auth | Params | Result | Errors |
|---|---|---|---|---|
| `monitors/discover` | none | — | `{supportedVersions, capabilities:{monitors:{listChanged}, feeds:{pull, http, mcp}, leases:{}}, limits, serverInfo, ttlMs}` | — |
| `monitors/list` | none | `{filter?, visibility?, cursor?}` | `{monitors:[Monitor], nextCursor?, ttlMs, cacheScope}` — `private` monitors only to their owner/bearer | |
| `monitors/get` | owner or bearer if private | `{id}` | `Monitor` | `NOT_FOUND` |
| `monitors/create` | the registration token, when the server requires one | `Monitor` minus server fields; `registration_token` may travel in the body | `Monitor` + emits `…configured{action:create}` | `INVALID_FILTER`, `UNKNOWN_VOCABULARY`, `DUPLICATE` |
| `monitors/update` | owner | `{id, patch, reason}` | `Monitor` (version+1) + `…configured{action:update, diff}` | as above |
| `monitors/pause` · `monitors/resume` · `monitors/retire` | owner | `{id, reason}` | `Monitor` + `…configured` | `NOT_FOUND` |
| `monitors/state` | anyone the visibility allows | `{id}` | `State` | `NOT_FOUND` |
| `monitors/publish` | owner (the producer) | `{id, type, subject?, data, tier?, origin?, verification?, actor?, rule?, wasDerivedFrom?, supersedes?}` | `{observation: Observation, seq}` + the row in the monitor's log. `origin` defaults from the actor's kind, `verification` from origin. A refusal is itself an `…rejected` observation (P2). | `UNKNOWN_VOCABULARY`, `TIER_NOT_ASSERTABLE` |
| `feeds/subscribe` | anyone the visibility allows | `{monitor, subscriber, filter?, capabilities, protocol?, sink?, from?: "head"|"earliest"|int, reset_policy?}` | `{subscription: Subscription, token}` (token once) + emits `…subscribed` | `INVALID_FILTER`, `CAPABILITY_MISSING` (grant smaller than asked), `CURSOR_BACKWARDS` (explicit `from` below stored) |
| `feeds/pull` | bearer | `{subscription, cursor?, wait?, limit?, filter?}` | `{observations:[Observation], cursor, next, head, lag, retention_floor, redelivered:int}`; does **not** advance the cursor; `cursor` param is a read-only replay ≥ `retention_floor`; inline `filter` intersects, never widens | `UNAUTHORIZED`, `CURSOR_EXPIRED` (410 semantics: `{retention_floor, relist: "monitors/state"}`) |
| `feeds/ack` | bearer | `{subscription, cursor}` | `{cursor, head, lag}` — cumulative commit; below stored → `CURSOR_BACKWARDS`; equal → no-op returning prior result (idempotent) | |
| `feeds/seek` | bearer | `{subscription, cursor, reason}` | `{cursor}` + emits `…subscribed{seek}` — the only way backwards, explicit and logged | `CURSOR_EXPIRED` |
| `feeds/renew` | bearer | `{subscription}` | `{subscription, token}` — new token, same cursor | |
| `feeds/retire` | bearer | `{subscription, reason}` | `{ok}` + emits `…subscription_retired` and releases leases | |
| `leases/claim` | bearer + `act` | `{subscription, subject, lease_duration_seconds, note}` | `Lease` + `…lease{claim}`; one conditional write; held → `LEASE_HELD{holder, renew_time}` | `CAPABILITY_MISSING` |
| `leases/renew` | bearer + `act` | `{subscription, subject, lease_duration_seconds?, note}` | `Lease` | `LEASE_LOST` |
| `leases/complete` | bearer + `act` | `{subscription, subject, outcome, evidence:[{source,id}], note}` | `{ok}` + `…lease{complete}`; conditioned on still holding; an implementation MAY require `evidence` (Atrio does for tickets) | `LEASE_LOST`, `EVIDENCE_REQUIRED` |
| `leases/release` · `leases/reject` | bearer + `act` | `{subscription, subject, reason}` | `{ok}` + `…lease{release|reject}`; `reject` after `delivery_count_limit` dead-letters | |
| `notifications/monitors/observation` | server → client (wake-up only) | `{subscription, head}` | — | best-effort; delivery is `feeds/pull` |
| `notifications/monitors/state` | server → client | `{monitor, as_of_seq}` | — | best-effort |

Error object, in two shapes for two transports. Over REST the body **is** the error object
(`schemas/error.json`): `{code, error, done, …}`. Over JSON-RPC it travels as
`error{code: <numeric, implementation range -32000…-32019>, message, data: <that same object>}`.
The name `code` therefore means the string over REST and the number over JSON-RPC; `data.code`
carries the string in both. The closed list: `INVALID_FILTER` · `UNKNOWN_VOCABULARY` · `TIER_NOT_ASSERTABLE`
· `PROVENANCE_CEILING` · `INVALID` · `CAPABILITY_MISSING` · `UNAUTHORIZED` · `NOT_FOUND` · `DUPLICATE` ·
`CURSOR_BACKWARDS` · `CURSOR_EXPIRED` · `LEASE_HELD` · `LEASE_LOST` · `EVIDENCE_REQUIRED` ·
`OVER_BUDGET`. `data`
always names what was done before the refusal (`done: []`) when a compound request partially
applied (Atrio §5).

## REST binding (for implementations without JSON-RPC)

| Method | REST |
|---|---|
| `monitors/discover` | `GET /mp/v0/discover` |
| `monitors/list` · `get` | `GET /mp/v0/monitors[?…]` · `GET /mp/v0/monitors/{id}` |
| `monitors/create` · `update` · `pause` · `resume` · `retire` | `POST /mp/v0/monitors` · `POST /mp/v0/monitors/{id}/{update|pause|resume|retire}` |
| `monitors/state` | `GET /mp/v0/monitors/{id}/state` |
| `monitors/publish` | `POST /mp/v0/monitors/{id}/observations` |
| `feeds/subscribe` | `POST /mp/v0/subscriptions` |
| `feeds/pull` | `GET /mp/v0/subscriptions/{id}/pull?cursor=&wait=&limit=&…filter` (`Accept: application/cloudevents-batch+json`) |
| `feeds/ack` · `seek` · `renew` · `retire` | `POST /mp/v0/subscriptions/{id}/{ack|seek|renew|retire}` |
| `leases/*` | `POST /mp/v0/subscriptions/{id}/leases/{claim|renew|complete|release|reject}` |
| SSE stream | `GET /mp/v0/subscriptions/{id}/stream` — `id: <seq>` per event; `Last-Event-ID` is the last event **received**, so the stream resumes at that seq plus one; the cursor still commits only by `ack` |
| admin (optional) | `POST /mp/v0/admin/compact`, `GET /mp/v0/admin/snapshot` — exist only when the server enables them, and **always require an admin token**; the snapshot carries token hashes and must never be anonymous |

HTTP status mapping: `INVALID_FILTER`/`UNKNOWN_VOCABULARY`/`TIER_NOT_ASSERTABLE` → 400 ·
`UNAUTHORIZED` → 401 · `CAPABILITY_MISSING`/`PROVENANCE_CEILING` → 403 · `NOT_FOUND` → 404 · `DUPLICATE`/
`CURSOR_BACKWARDS`/`LEASE_HELD`/`LEASE_LOST`/`EVIDENCE_REQUIRED` → 409 · `CURSOR_EXPIRED` → 410 ·
`OVER_BUDGET` → 429. Bearer token in `Authorization: Bearer`.
