# 03 — Bindings

## CloudEvents

Observations are CloudEvents 1.0 (`specversion: "1.0"`). JSON format `application/cloudevents+json`;
a pull returns `application/cloudevents-batch+json` (a JSON array). HTTP push (`protocol: http`)
uses binary mode (`ce-` headers) by default and structured mode on request. Extension attributes
defined here: `sequence` (CE's own extension, string, zero-padded), `tier`, `origin`, `verified`,
`horizon`, `actor`, `redelivered`; plus CE's `traceparent`/`tracestate`. Consumers MAY treat equal
`(source, id)` as duplicates (CE dedup rule); ordering is by `sequence` within one `source`
only. Map-shaped provenance lives in `data.provenance` because CE extensions are scalar.

## MCP extension `ai.mentu/monitors` (working id)

Declared as `"extensions": {"ai.mentu/monitors": {"version": "0.1"}}` in the server's
`server/discover` capabilities and in the client's per-request `_meta` capabilities. The
extension reserves the method prefixes `monitors/`, `feeds/`, `leases/` and the notification
prefix `notifications/monitors/`, following the Tasks extension's reservation form.

Presentation to an MCP host that knows nothing of the extension:

| MCP primitive | Mapping |
|---|---|
| tools | `monitor_discover`, `monitor_list`, `monitor_get`, `monitor_create`, `monitor_configure` (update/pause/resume/retire), `monitor_publish`, `monitor_state`, `monitor_subscribe`, `monitor_pull`, `monitor_ack`, `lease_claim`, `lease_complete`, `lease_release` — thin wrappers on the methods. Their `inputSchema`s are written for a model reading a tool list: flatter than the object schemas, and describing *arguments*, not the objects. `schemas/` stays normative for the objects those calls return. |
| resources | `monitor://{id}/definition` (the Monitor), `monitor://{id}/state` (the State) with `ttlMs` from `state.ttl_ms`; `resourceSubscriptions` in `subscriptions/listen` gives `notifications/resources/updated` when state changes |
| `subscriptions/listen` | filter key `monitorObservations: {"subscriptions": ["<id>"]}` acknowledged with `notifications/subscriptions/acknowledged`; the server then sends `notifications/monitors/observation {subscription, head}` tagged with `io.modelcontextprotocol/subscriptionId`. This is a **wake-up**: MCP notifications are best-effort and the server holds no listen state across reconnects, so the client pulls with `feeds/pull` and commits with `feeds/ack`. |
| MRTR | a `lease_complete` or `monitor_configure` that needs confirmation returns `resultType: "input_required"` with an elicitation; the client retries with `inputResponses`. |
| sampling | not used (deprecated in 2026-07-28; P9 forbids it anyway). |

Statelessness consequence: every `feeds/*` call carries the subscription bearer token; the
subscription id is ours and durable; MCP's `subscriptionId` is only the listen stream's.

## Claude Code Monitor tool (the simplest client)

`Monitor(command: "<impl> watch <subscription-id> --catch-up-first")` where `watch` runs the
pull/ack loop and prints one line per observation (`seq type subject tier actor`). One arm per
session against the hub; re-arm at the 30-minute deadline; `--catch-up` prints the backlog
without acking so the session sees what it missed (Atrio inbox standard).

## HTTP: who may call a local server

A Monitor Protocol server usually runs on the same machine as a web browser, so every web page its
user opens can reach it. A page is not the user.

- A server **MUST** refuse, with `403 ORIGIN_REFUSED`, any request whose `Origin` header names an
  origin its operator has not allowed. Requests without an `Origin` (command line tools, the `watch`
  client, other servers) are unaffected. An allowed origin receives
  `Access-Control-Allow-Origin` and an answer to its preflight. This is the rule MCP sets for its own
  HTTP transport, for the same reason. Checked by C30.
- On a connection that arrives on a loopback address, a server **SHOULD** refuse a `Host` header
  that does not name the machine (`localhost`, `127.0.0.1`, `::1`, or a name the operator allowed),
  because that is what a DNS-rebinding page sends.
- A server **SHOULD** cap request bodies and refuse larger ones with `413 TOO_LARGE` before reading
  them in full. The reference server's limit is 1 MiB.

## Server-sent events

`GET /mp/v0/subscriptions/{id}/stream` frames each observation as `id: <seq>`, `event: observation`,
`data: <CloudEvent JSON>`. `Last-Event-ID` resumes the stream where it stopped, and `retry:` asks
the browser to reconnect after 3 s. A heartbeat frame every five seconds keeps proxies from closing
the connection and is how the server notices a reader that went away. The stream is a delivery
mechanism, not a commit: the cursor still moves only on `feeds/ack`.

## HTTP push (`protocol: http`)

Standard Webhooks headers on every delivery: `webhook-id` = CE `id`, `webhook-timestamp` (unix
seconds), `webhook-signature` (`v1,` HMAC-SHA256 base64 over `id.timestamp.payload`). Receiver
`2xx` = delivered (the server commits the cursor for push subscriptions); `410 Gone` retires the
subscription; other failures retry with multi-day exponential backoff and jitter; a rejected
signature on the receiving side is still evidence there (P2).

## Nostr (optional relay bridge)

A monitor MAY be mirrored to a Nostr relay as addressable events (kind in `30000–39999`, `d` tag =
`source`), with the CloudEvent JSON as `content` and `tier`/`origin`/`horizon` as tags, so Nostr
clients can subscribe with the same filter grammar. The relay adds no delivery guarantee; the
cursor stays on our side.
