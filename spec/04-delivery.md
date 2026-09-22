# 04 — Delivery semantics

Adopted, with the established name for each (see `docs/delivery-semantics.md` for sources).

| Behaviour | Name we use | Specification |
|---|---|---|
| Guarantee | **at-least-once** (Kafka's wording) | Observations are never lost within retention; they may be redelivered. Exactly-once is idempotent processing by `(source, seq)`, not a transport property. |
| Cursor | **committed position** (Kafka) | One integer per subscription = next `seq` to deliver. Ordered and collatable; not opaque (do not call it `resourceVersion`). |
| Pull | position vs committed position | `feeds/pull` returns from `cursor` (or an explicit read-only `cursor` ≥ `retention_floor`) and never commits. |
| Commit | ack after processing = "read, process, then save position" | `feeds/ack` after side effects. Cumulative. Equal or lower than stored → no-op / `CURSOR_BACKWARDS`. Manual commit is the only mode (Kafka's auto-commit default leaks toward at-most-once; we do not offer it). |
| Redelivery | recover to committed position; RabbitMQ `redelivered` | A pull after a crash returns the uncommitted range again with `redelivered: true` on each observation. |
| Head and lag | log-end offset vs position | `head` is the real maximum of the monitor's log, never the filtered slice; `lag = head − cursor` (P5). |
| Explicit rewind | Kafka `seek` | `feeds/seek` only, logged as `…subscribed{seek, reason}`. |
| Compacted lag | Kafka `OutOfRangeException` + `auto.offset.reset`; K8s `410 Gone`, `reason: Expired` → relist | A cursor below `retention_floor` → `CURSOR_EXPIRED` with `{retention_floor, relist}`; the subscriber reads `monitors/state`, then pulls from `retention_floor` (or `head` if `reset_policy: latest`); the replay after a relist ends with an `ai.mentu.monitor.bookmark` observation (K8s `initial-events-end`). |
| Retained state | MQTT retained message; Kafka compaction's "last known value" | Each monitor keeps one current State beside the stream; a new subscriber MAY read it before its first pull. |
| Lease | K8s Lease fields; Kafka share-group acquisition lock | `holder`, `lease_duration_seconds`, `acquire_time`, `renew_time`, `lease_transitions`; expired when `now > renew_time + lease_duration_seconds`; renew at ≤ half the duration; acquisition is one conditional write (Atrio's UPDATE … WHERE free-or-mine-or-expired). |
| Attempt cap | Kafka `group.share.delivery.count.limit`; RabbitMQ `delivery_limit` | `attempts` per `(subject)`; `reject` past `delivery_count_limit` emits `…lease{reject, dead_letter: true}`. |
| Dead subscriber | Kafka `max.poll.interval.ms` "considered failed"; MQTT Session Expiry + Will | No pull or renew within `retire_after_mute_seconds` → subscription retired, leases released, cursor kept for `offsets_retention` then dropped, a will observation `…subscription_retired{mute_since}` emitted (P6). |
| Stream resume | SSE `id:` + `Last-Event-ID` | The optional SSE binding sends `id: <seq>`; reconnect resumes the stream, but only `ack` commits. MCP 2026-07-28 removed this from its transport; we keep it in ours. |
| Idempotent writes | Idempotency-Key (vocabulary), Stripe (practice), `webhook-id` | Re-sending an `ack`, `claim` or `complete` with the same arguments returns the prior result, success or error. |

**Single-writer note.** A conformant server may serialise all writes (Atrio does, under one
lock). "Kafka-like" here is about semantics, never throughput.
