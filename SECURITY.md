# Security Policy

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

Report through [GitHub's private vulnerability reporting](https://github.com/mentu-ai/monitor-protocol/security/advisories/new)
with a description, steps to reproduce, impact and a suggested fix if you have one. We acknowledge
within 48 hours and give a timeline.

## Scope

- Bearer token handling: owner tokens and subscription tokens are shown once and stored hashed;
  any path that logs, echoes or persists a plaintext token is in scope.
- Capability enforcement: a subscription performing an action its declared capabilities do not
  cover; a private monitor visible without its owner token.
- Provenance inflation: any path by which a non-human origin obtains `tier: src`.
- Cursor and lease integrity: a cursor moved backwards without `seek`, a lease taken from a live
  holder, a completion accepted after the lease was lost.
- Admin endpoints reachable without `--allow-admin`.

## Out of scope

- Vulnerabilities in monitors' sources (the systems being observed).
- Denial of service against a single-writer reference server run on a public interface; run it
  behind an authenticating proxy.
