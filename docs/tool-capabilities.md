# Session tool capability admission

A launched session has a tool capability only when that session can call the tool
successfully under its actual configuration. Choosing the same model, discovering a
cached catalogue, starting a process, or connecting to MCP does not establish parity
with an application that hosts additional tools.

`src/session/capabilities.ts` supplies a consumer-side admission library. It changes
no Monitor Protocol objects or acknowledgement semantics. The first adapter checks
MCP tools on an **already loaded, host-owned Codex app-server thread**, using that
thread's existing connection. It never starts or resumes a thread and never creates
a separate MCP client that could have different tools or credentials.

## Scope

| Capability | What this instrument establishes |
|---|---|
| Required MCP tools | Exact advertised contracts are present, connected, and pass fresh operator-defined calls through the target thread |
| Native shell, file editing, image reading, subagents | Outside MCP v1; need separate native capability probes |
| Model selection and tool use | Not tested by a direct RPC call; need a separately authorized model canary |
| Application computer-use bridge, browser state, connectors | Not inherited or inferred; supply an independently authorized provider and probe it |
| Idle wake and task completion | Not established; retain independent wake and durable work receipts |

Supported host requirements are the actual RPC shapes described below. No particular
released Codex version or platform is certified by unit tests. A runtime that lacks
these methods or cannot report a connected thread-bound server fails admission.

## Trusted profile and binding

The operator supplies the profile from trusted host configuration. Observations,
tickets, model outputs, and request bodies **must not select tools, arguments,
assertions, digests, or bindings**. The host holds any authorization needed to make
the read-only probe. A server's `readOnlyHint` alone is not that authorization.

```ts
const binding: CapabilityBinding = {
  provider: "codex",
  sessionId: "owned-thread-id",
  runtimeId: "unique-runtime-incarnation",
  configSha256: "sha256:<64 lowercase hexadecimal characters>",
  workspace: "/operator-resolved/workspace",
};

const profile: CapabilityProfile = {
  version: 1,
  id: "ticket-read-v1",
  ttlMs: 30_000,
  timeoutMs: 5_000,
  required: [{
    id: "tickets.read",
    server: "tickets",
    tool: "get_ticket",
    toolSha256: "sha256:<operator-reviewed tool contract digest>",
    probe: {
      kind: "read-only",
      arguments: { id: "operator-designated-test-ticket" },
      assertions: [
        { path: "/structuredContent/id", equals: "operator-designated-test-ticket" },
        { path: "/structuredContent/readable", equals: true },
      ],
    },
  }],
};
```

`capabilityDigest(value)` hashes canonical JSON: recursively sorted object keys,
UTF-8, no trailing newline, `sha256:` prefix. Pin the **full advertised MCP Tool
object**, including its schema, description, and annotations. Review contract
changes; do not automatically replace a pin with whatever discovery returns.

The host's `getBinding(signal)` must read its current, authoritative runtime state.
It must not simply echo the expected binding. The configuration digest covers the
effective model, tool attachment, permissions, and other relevant runtime settings.
The runtime ID changes on restart or reconnection; the workspace is resolved by
the host. All five fields are compared exactly before and after inventory, before
and after each probe, and immediately before admitted work. A profile is copied
before any asynchronous operation, so later caller mutation cannot substitute a
probe target.

## Integrate with the owning transport

```ts
const adapter = new CodexAppServerCapabilities(
  ownedAppServerRpc, // request(method, params, { signal }) -> parsed result
  readCurrentOwnedSessionBinding,
);

const { receipt, result } = await admitCapabilityWork(
  profile, binding, adapter,
  async receipt => {
    await persistHostEvidence(receipt);
    return executeAlreadyAuthorizedWork();
  },
);
```

The injected transport rejects JSON-RPC errors and respects cancellation. It must
be bound to the same owned runtime represented by `getBinding`. The library sends:

1. `mcpServerStatus/list` with the exact `threadId`, `detail: "toolsAndAuthOnly"`,
   and bounded pagination. It requires `runtimeStatus: "connected"` and no
   discovery error for a server to contribute tools.
2. `mcpServer/tool/call` with the same `threadId` and the profile's fixed server,
   tool, and arguments for every required capability.

It validates every required contract before probing any tool. Duplicate capability
IDs, duplicate server/tool requirements, invalid catalogues, missing tools, contract
drift, RPC failures, malformed MCP results, `isError`, failed semantic assertions,
binding drift, deadline overrun, and expiry refuse admission. JSON pointer assertions
support escaped keys and compare complete JSON values, distinguishing missing from
`null`. The timeout covers the entire preflight, including binding discovery and
pagination; a monotonic deadline also catches synchronous work that delays timers.

Probes should read known fixtures or bounded status surfaces. Avoid production
writes, external sends, or merely asking a tool to claim it is healthy. A fresh RPC
call proves that this dispatch path returned the asserted result; it cannot prove
that a remote service did not cache its own response. Choose meaningful assertions
and, when necessary, an operator-controlled freshness fixture.

The host must serialize session/configuration changes and retain its ownership lease
while the admitted callback runs. The library checks at admission; it cannot stop a
remote configuration change during asynchronous work. A timeout refuses the callback
even if a late RPC eventually succeeds, but transport cancellation cannot guarantee
that the server has stopped executing. There is no automatic retry.

## Receipts and recovery

`preflightCapabilities(profile, binding, adapter)` returns a receipt without running
work. `admitCapabilityWork` always performs a fresh preflight and gives the supplied
callback its receipt. It never accepts an old receipt as permission to run.

The receipt contains:

- Random `runId` and unpredictable `nonce`.
- Exact binding and profile digest.
- `issuedAt` and `expiresAt`, measured from preflight start.
- Required capability/tool contract digests and probe result digests.
- A digest of the receipt itself.

Raw tool results, credentials, and raw RPC errors are not retained. Store receipts
privately using the host's durable journal. `assertCapabilityReceipt` checks a
retained receipt against its profile, exact binding, integrity digest, and lifetime.
Restart, workspace/configuration/profile change, expiry, or clock rollback makes it
unusable for current readiness. Recheck after relevant provider or credential changes.

These are **same-user trusted-host evidence**, not cryptographic attestation or bearer
credentials. A person who can alter the profile, adapter, or receipt can also forge
the evidence. The nonce distinguishes attempts; it is not a signature. Durable work
reporting and Monitor Protocol acknowledgement remain the consumer's responsibility:
capability verification alone never acknowledges an observation.

## One workspace profile across providers

`WorkspaceCapabilityProfile` names semantic requirements once and expands them into
concrete tool/probe contracts for each provider:

```ts
const workspaceProfile = {
  version: 1 as const, id: "ticket-review-v1", ttlMs: 30_000, timeoutMs: 10_000,
  required: ["tickets.read"],
  providers: {
    codex: [codexTicketReadRequirement],
    claude: [claudeTicketReadRequirement],
  },
};
await admitWorkspaceCapabilityWork(workspaceProfile, binding, owningSessionAdapter,
  receipt => executeInThisSameSession(receipt));
```

Each expansion must contain exactly the shared IDs: no missing, extra, or duplicate
capabilities. Selection uses the exact `binding.provider`; no fallback or weakening.
Every admission performs fresh probes. A missing concrete adapter refuses work, even
when a static provider mapping exists. This package supplies the Codex MCP adapter;
the example does not imply that a Claude transport has been implemented.

The callback must execute in the probed session under the same host lease. Checking
one app-server thread and then launching a different `codex exec` process does not
establish readiness for that new process. Native tools and application facilities
outside MCP still need their own verified adapters. See the
[shared harness contract](shared-harness-contract.md).

Failures use `CapabilityAdmissionError.code`: `INVALID_PROFILE`, `INVALID_BINDING`,
`BINDING_CHANGED`, `INVALID_INVENTORY`, `MISSING_CAPABILITY`, `SCHEMA_MISMATCH`,
`PROBE_FAILED`, `TIMEOUT`, `EXPIRED_RECEIPT`, `INVALID_RECEIPT`, or `ADAPTER_FAILED`.

## Verification

The isolated tests use an injected fake app-server transport and make no model or
network calls. They cover real-call failure behind a cached catalogue, wrong
thread/configuration/runtime/workspace, changing bindings, schema drift, duplicates,
semantic errors, pagination, late replies, synchronous timeout overrun, receipt
replay/expiry, and refusal before callback execution.

```sh
npm run build
node --test dist/__tests__/session-capabilities.test.js
```

A live integration test must separately show the exact loaded thread, effective
configuration digest, required tool inventory, actual harmless calls, and resulting
receipt. Model access, computer-use behavior, and idle wake each need their own
identified trial before claiming application-level parity.

Official interface references: [Codex app-server](https://learn.chatgpt.com/docs/app-server)
and [MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
