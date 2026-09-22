# Monitor Protocol v0.1.0

The first public cut. An epistemic layer over pub/sub: monitors emit evidence with provenance,
keep a computed state that names its gaps, and are consumed through a durable cursor.

Highlights: CloudEvents envelope, MCP extension door, Nostr-shaped filters, Kafka-shaped delivery,
21-check conformance suite, reference server and Claude Code `watch` client.

Known limits: single-writer in-memory store; HTTP push (`protocol: http`) declared but not served
yet; the vendor prefix `ai.mentu` is a working name.
