# A shared workspace across Claude Code and Codex

**Status:** integration contract with implemented Codex MCP capability admission.
Claude plugin integration and a live cross-provider continuity trial remain pending.
This document adds no Monitor Protocol wire objects and does not certify tool parity.

The workspace owns its tickets, recipe versions, observations, and evidence. Each
harness supplies a session adapter and its native tools, hooks, permissions, and UI.
Claude Code and Codex can therefore work on the same project without making either
application's session format the shared source of truth.

## What is shared

| Contract | Required binding |
|---|---|
| Participant | Distinct actor, host-owned session/runtime identity, and its own credentials; a display name is not authentication |
| Ticket/work | Canonical `work_ref` and actual owner/claim; do not create a second ticket merely to display it in another harness |
| Observation | Original source/id, fingerprint, provenance, and triggering reference; repeated delivery is not new evidence or authorization |
| Subscription | Independent subscription and durable cursor per participant/consumer; delivery independence does not provide exclusive work ownership |
| Routine | Operator-approved recipe/version, plan digest, frozen input manifest, declared backend/model, limits, and stable occurrence/request key |
| Capabilities | Shared semantic requirement IDs, exact provider-specific tool bindings, contract digests, and fresh session-bound probe receipts |
| Outcome | Durable disposition, authoritative run state, evidence reference, and reporter idempotency; only then may the consumer acknowledge |

Store credentials locally through the host's approved mechanism. Distribute recipe,
tool, skill, and context versions by reference and integrity check; do not synchronize
credential stores, transcripts, or mutable home directories between providers.

See [session delivery](session-bridge.md), [bounded routines](use-cases/event-triggered-routines.md),
and [tool capability admission](tool-capabilities.md) for the implemented boundaries.

## Reuse the Claude plugin design

Mentu's existing Claude design separates four components:

| Component | Role and order |
|---|---|
| `mentu-core` | Establishes the typed `$.mentu` interface for ledger capture, commitments, gates, briefs, and usage evidence |
| `mentu-ledger` | Audits lifecycle/tool events; seats before the guard so denied calls are observed |
| `mentu-guard` | Applies tool and permission policy after the outer audit layer |
| `mentu-board` | Displays commitments/gates and submits decisions through the same underlying interface |

The local marketplace order is **core → ledger → guard → board**. These are existing
Mentu components, not plugins distributed by this package. Their source lives under
`mentu-hooks/claude-mods/`, with manifests, `hooks/hooks.json`, hook modules, tests,
and `mentu-core/types/index.d.ts`. Historical host tests do not establish that a
different installed version loads or enforces them today.

Claude plugins can package skills, hook modules, and MCP servers. These are distinct
roles: skills teach a workflow, hooks translate lifecycle/policy boundaries, MCP
provides callable capabilities, and UI presents state. None substitutes for shared
monitor delivery or a durable handling receipt. [Claude plugin documentation](https://code.claude.com/docs/en/plugins).

The host-neutral policy core already expresses `AgentEvent → Decision`, with
`allow`, `deny`, `ask`, `pass`, `inject`, and `annotate`. Retain that vocabulary at the
adapter boundary; preserve native hook names as provenance. A normalized event must
carry the real actor, session, workspace, run, tool, and relevant evidence references.
An unknown identity can be audited as unknown, but cannot authorize work or acknowledge
a participant's delivery.

Two source gaps prevent treating the existing hooks as parity proof:

- The Python capability registry describes expected per-agent abilities; it does not
  probe the current session. Its Codex decoder leaves session/workspace/run metadata
  at defaults, while its encoder emits no context for `inject`. These need host-bound
  normalization and behavior tests before claiming equivalent context delivery.
- The Claude guard's source distinguishes caught destructive-check failures from a
  host-budget timeout that can remove the hook. Required admission must fail closed
  at the host boundary; an optional courier or UI hook cannot provide that guarantee.

Audit pointers: `mentu-hooks/mentu_policy/{abi,capabilities,degrade}.py`,
`mentu-hooks/mentu_policy/adapters/{claude,codex}.py`, and
`mentu-hooks/claude-mods/mentu-guard/hooks/register.ts`.

## Same requirements, native adapters

Give semantic requirements stable IDs such as `tickets.read`, `workspace.read`, or
`desktop.observe`. Their provider mappings may use different MCP names, schemas,
and probe arguments. The required ID set stays identical across the workspace.
Resolve the selected provider's exact expansion with
`resolveWorkspaceCapabilityProfile`, then use `admitWorkspaceCapabilityWork` for
fresh admission. Missing, duplicate, or extra mappings must not silently weaken the
workspace profile. The host supplies this configuration; an event cannot choose it.

Codex admission uses the owning thread's `mcpServerStatus/list` and
`mcpServer/tool/call`. A Claude adapter must produce the same receipt contract through
its actual session tool path; calling a separate MCP client is insufficient. The
current library provides the provider-neutral interface and the concrete Codex
adapter. It does not yet provide that concrete Claude adapter. Native shell tools,
model-selected tool calls, and application-private facilities require separate probes.
[Codex app-server documentation](https://learn.chatgpt.com/docs/app-server).

Keep plugin version, effective configuration, permission policy, runtime incarnation,
session identity, and workspace bound to readiness. A reload, restart, credential or
configuration change invalidates the relevant readiness. Required tool failures
refuse the task; an optional capability may be omitted only when the shared profile
explicitly permits it. A static declaration is not a live receipt.

## Claude host metadata required before admission

The reviewed Claude Mods declarations expose `$.tool.call`, which follows the model's
normal tool event and permission path. Prefer that path for probes. `$.mcp.call`
uses the host connection but skips permission prompts, so it does not establish the
same permission behavior. [Official declarations](https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts).

The reviewed `ToolInfo` inventory contains names, descriptions, and MCP identity,
without the full tool schema needed by this library's contract digest. Session ID
and working directory are available, but a complete runtime incarnation and effective
configuration binding were not established. Local declarations identify 2.1.271;
the official declarations reviewed identify 2.1.277. The installed 2.1.296 runtime
was not loaded or probed for this integration. Generate and inspect that runtime's
own declarations before relying on an interface. [Mods reference](https://code.claude.com/docs/en/plugins/mods/reference).

The owning host must supply full effective Tool objects, catalog revision, an
authoritative session/runtime/configuration/workspace binding, and lifecycle
invalidation covering probes and admitted work. Until then, refuse strict admission.
Do not fill missing schemas from the expected profile, use a second MCP client, or
convert static plugin declarations into readiness evidence. The generic adapter
interface already supports this future host connection; another wrapper cannot
supply missing host facts.

## Delivery, hooks, and receipts

```text
shared ticket observation
  → participant's subscription
  → trusted adapter and existing authority
  → claim/occurrence deduplication + fresh capability admission
  → attended session handling OR an admitted bounded routine
  → durable disposition and evidence
  → acknowledgement by that subscription's consumer
```

A post-tool success means a tool returned. A turn ending means the host stopped
generating. Neither establishes semantic handling of a particular delivery.
`mentu-ledger` audit/CIR capture remains a courier; it does not implicitly acknowledge
Monitor Protocol work. Preserve receipt provenance and avoid double-counting the
same native event when shell hooks and function hooks coexist. Exclude self-produced
audit/receipt events from routine triggers unless an explicit policy requests them.

When a report fails, retain the existing run and retry reporting. When a launch or
effect is uncertain, reconcile it instead of rerunning the model. Shared tickets
still require their own claims; two subscribers seeing the same observation must
not both acquire the same work by inference.

## Lifetime and current readiness

| Adapter/workflow | Current boundary |
|---|---|
| Codex native monitor preview | Harness integration for an owned live frontend; each installed build still needs an identified idle-wake trial |
| Codex queue bridge | Operator-bound existing terminal, only where that exact binary and process arrangement support queue delivery; queue acceptance is not handling |
| Codex MCP capability admission | Implemented fresh probes through an already loaded owned thread; establishes dispatch capability, not model selection or idle wake |
| Claude Monitor + Mentu plugin integration | Integration path identified; shared receipt/admission wiring and a live interoperability trial are pending |
| Pull workflow | Portable fallback: read, inspect under existing authority, handle, record evidence, then acknowledge |
| Bounded routine | Separate approved launcher policy; a new finite run may outlive an interactive turn, within its declared ownership and limits |

An attended monitor stops when its bound session ends or the person stops it. It
must not silently create a replacement session. A bounded routine is separately
authorized by its launch policy; it does not pretend to be a still-attended session.
The [workspace status view](workspace-status.md) keeps transport health, capability
readiness, and native wake as separate observations.

The interoperability acceptance test is bidirectional: the operator leaves one
session idle; the other creates the authorized test ticket; the receiver wakes,
reads the canonical ticket through its own verified tools, reports evidence, and
only then acknowledges. Repeat in the opposite direction, then test duplicate
delivery, tool outage, session replacement, and reporting failure. Record each
provider/runtime version and distinguish dispatch, model action, handling, and wake
evidence. Until that trial passes, describe coexistence as configured or pending,
not verified parity.
