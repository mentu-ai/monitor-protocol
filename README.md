# Monitor Protocol

[![npm version](https://img.shields.io/npm/v/@mentu/monitor-protocol)](https://www.npmjs.com/package/@mentu/monitor-protocol)
[![Node.js 20 or newer](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![CI status](https://github.com/mentu-ai/monitor-protocol/actions/workflows/ci.yml/badge.svg)](https://github.com/mentu-ai/monitor-protocol/actions/workflows/ci.yml)

**The Claude Code Monitor tool idea, taken out of the session and made durable, shareable and accountable.**

[Read the documentation](https://docs.mentu.ai/monitor-protocol/overview) · [Try it in your browser](https://docs.mentu.ai/monitor-protocol/playground) · [Quickstart](https://docs.mentu.ai/monitor-protocol/quickstart) · [Package on npm](https://www.npmjs.com/package/@mentu/monitor-protocol)

## The idea

The Claude Code Monitor tool has the right instinct. You point it at something, it watches, and it tells you when something happens.

Its limits come from where it lives. It stops when the session stops. It runs for [thirty minutes at most](https://code.claude.com/docs/en/tools-reference). Only the session that started it can see it. And it remembers nothing. So every session starts its own watches again, and whatever happened in between is gone.

The Monitor Protocol keeps the instinct and removes those limits. A monitor becomes something that exists on its own. Many people and agents can subscribe to it. It remembers what it saw. And an AI can set it up or change it through a defined interface, instead of editing a script.

## What it does

There are five parts, and each one is small.

- **A monitor** is a definition: what is watched, how often, and with what authority.
- **An observation** is one thing the monitor saw. Each one says where it came from, who caused it, and how much it is worth believing.
- **A state** is the monitor's running summary, computed from its observations. It says out loud what it does not know, instead of filling the gap with a number.
- **A subscription** is a reader with its own place in the stream, called its cursor. It reads, does the work, and only then acknowledges. A reader that crashes gets the same items again instead of losing them.
- **A lease** is how two workers avoid doing the same job twice. It expires on its own if the worker holding it stops.

Configuration is not a sixth part. Pausing a monitor, changing its filter or retiring it is recorded as an observation too. Six months later, the question "why did this change?" has an answer.

## What makes it more than a queue

A queue moves messages and forgets them. The Monitor Protocol keeps them as evidence.

**A machine cannot claim a person's level of certainty.** Every observation carries a rating, from `src` (a person checked it against the source) down to `falsified` (checked, and found untrue). A program can report what it measured. The top of the ladder needs a person behind the observation. An agent working for you reaches your level by naming you in one field, `on_behalf_of`, and the record keeps both names: the agent that saw it, and the person it worked for. It can only name the person who owns the monitor, so it cannot borrow anyone else's level. Anything that tries to climb higher is refused, and the refusal is kept as an observation.

An independent audit showed that the first version of this check could be fooled, because it read its answer from the same request it was judging. It is now enforced, and the conformance suite tests it from five different angles.

**It does not lie by leaving things out.** A confidence with a missing input lists the input as missing. A source that did not answer is reported as not answering, never as zero. The count of waiting items covers only what this reader would actually receive, so it can reach zero.

## Try it

The fastest way is the [playground](https://docs.mentu.ai/monitor-protocol/playground): the real engine runs in your browser, and nothing leaves the page.

To run it yourself, you need [Node.js](https://nodejs.org) 20 or newer. Start a server:

```bash
npx @mentu/monitor-protocol serve --port 8130
```

Then, in use, it is four steps:

```bash
# 1. Define what is watched. The reply includes an owner token, shown once. Keep it.
curl -s localhost:8130/mp/v0/monitors \
  -d '{"id":"ci","name":"CI","horizon":"minute","capabilities":["observe"],"visibility":"public","types":["com.example.ci.run"]}'

# 2. A producer records what it saw, using the owner token.
curl -s localhost:8130/mp/v0/monitors/ci/observations -H "Authorization: Bearer $OWNER_TOKEN" \
  -d '{"type":"com.example.ci.run","subject":"build-412","actor":"probe:ci","tier":"measured","origin":"probe","data":{"status":"failed"}}'

# 3. A reader subscribes once, then takes what it has not seen yet.
curl -s localhost:8130/mp/v0/subscriptions -d '{"monitor":"ci","subscriber":"agent:claude","capabilities":["observe"]}'
curl -s "localhost:8130/mp/v0/subscriptions/$SUBSCRIPTION/pull" -H "Authorization: Bearer $READER_TOKEN"

# 4. It commits only after handling it. Send the "next" value from the pull reply.
curl -s localhost:8130/mp/v0/subscriptions/$SUBSCRIPTION/ack -H "Authorization: Bearer $READER_TOKEN" -d '{"cursor": 3}'
```

Reading never moves the cursor. Only an acknowledgement does, and it never moves backwards. The [quickstart](https://docs.mentu.ai/monitor-protocol/quickstart) walks through each reply.

## Use it from Claude Code and other AI tools

From Claude Code, it is one watch per session against the monitor server, instead of one per thing. From any AI client, it is a set of tools over the [Model Context Protocol](https://modelcontextprotocol.io) (MCP).

Add it to Claude Code as an MCP server. It runs its own monitor server, so give it its own state file:

```bash
claude mcp add -s user monitor-protocol -- npx -y @mentu/monitor-protocol mcp --state ~/.monitor-protocol/mcp-state.json
```

Or follow a subscription from a session with the Monitor tool:

```text
Monitor(command: "npx -y @mentu/monitor-protocol watch --base http://localhost:8130 --subscription <id> --token <token> --catch-up")
```

The watch prints one line per observation and acknowledges each batch after printing it. When the Monitor's time runs out, start it again. The subscription remembers its place, so nothing is missed. The guide [Claude Code and MCP](https://docs.mentu.ai/monitor-protocol/claude-code) covers both, and the tools.

## Learn more

- [What is the Monitor Protocol?](https://docs.mentu.ai/monitor-protocol/overview)
- [Introducing the Monitor Protocol](https://docs.mentu.ai/monitor-protocol/introducing): why we built it, and how it works
- [Agents acting for people](https://docs.mentu.ai/monitor-protocol/trust): the trust rules in plain words
- [Concepts](https://docs.mentu.ai/monitor-protocol/concepts) and [Reference](https://docs.mentu.ai/monitor-protocol/reference)
- [The fourteen principles](spec/00-principles.md), each one learned from something that went wrong in a running system

## What is in this repository

| Folder | What it holds |
| --- | --- |
| [`spec/`](spec/) | The specification: [principles](spec/00-principles.md), [objects](spec/01-objects.md), [methods](spec/02-methods.md), [bindings](spec/03-bindings.md), [delivery](spec/04-delivery.md) and the [conformance checklist](spec/05-conformance.md) |
| [`schemas/`](schemas/) | A JSON Schema for every object. Where the prose and a schema disagree, the schema wins. |
| [`src/`](src/) | The reference server, the command line tool, the MCP server and a client, in TypeScript |
| [`conformance/`](conformance/) | The conformance suite in Python, next to the TypeScript one in `src/` |
| [`adapters/`](adapters/README.md) | Known implementations, and what each one taught the specification |
| [`docs/`](docs/) | Why each design choice was made, including a running [decision log](docs/decisions.md) |

## Build your own implementation

Read the [principles](spec/00-principles.md), implement the five objects over HTTP, and run the conformance suite against your server:

```bash
npx @mentu/monitor-protocol conform --base http://127.0.0.1:8124
python3 conformance/python/run.py --base http://127.0.0.1:8124 --subjects a,b,c
```

The suite has 30 checks. Two implementations run it today. The reference server in this repository passes all 30. Atrio, an event log, passes 29 and skips one, because it keeps everything and cursor expiry cannot be tested there.

To use the reference server as a library:

```ts
import { MemoryStore, MonitorService, createHttpServer, MonitorClient } from "@mentu/monitor-protocol";
const service = new MonitorService(new MemoryStore("state.json"));
```

## Status

Version 0.1, published on npm. The objects and methods are stable enough to build on. Names such as the `ai.mentu` prefix may still change before version 1.0, and every change is listed in the [changelog](CHANGELOG.md). Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache 2.0](LICENSE).
