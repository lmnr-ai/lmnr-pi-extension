# lmnr-pi-extension

Laminar observability for the [pi coding agent](https://github.com/badlogic/pi-mono). A
pi extension that subscribes to pi lifecycle events and emits, **live and in-process**, one
Laminar trace per agent run — with LLM and tool spans — grouped into a Laminar session by
pi's session id, over OTLP/HTTP/JSON.

> **Status: working prototype** (wayfinder buildability spike). The design decisions it
> implements are recorded in [`wayfinder/`](./wayfinder/map.md). Reliability hardening and
> the shared-emitter code-reuse boundary are still open tickets.

## How it works

One Laminar **trace = one pi agent run** (`before_agent_start` → `agent_end`). Spans are
opened on start events and closed on end events (fully granular, realtime), flat under the
run root:

```
pi agent run            (lmnr.span.type=DEFAULT)  ← before_agent_start / agent_end
├─ LLM call (turn 0)    (LLM)                     ← message_start / message_end
├─ bash                 (TOOL)                    ← tool_execution_start / _end
├─ LLM call (turn 1)    (LLM)
└─ …
```

The OTLP emitter (`src/tracer.ts`) is reused from the Claude Code plugin. See
`wayfinder/tickets/002` and `005` for the trace/span model and attribute mapping.

## Configure (secrets via env — see `wayfinder/tickets/003`)

```sh
export LMNR_PROJECT_API_KEY="..."          # required; absent ⇒ tracing disabled (fail-open)
export LMNR_BASE_URL="https://api.lmnr.ai" # optional (default)
export LMNR_USER_ID="..."                  # optional
export LMNR_DEBUG="true"                    # optional; logs to ~/.pi/agent/lmnr-pi-extension.log
export LMNR_MAX_CHARS="20000"              # optional; input/output truncation cap
```

## Install (no build step — pi runs the `.ts` directly via jiti)

```sh
npm install                                # install the OpenTelemetry deps into node_modules
```

Then either load it explicitly:

```sh
pi -e /absolute/path/to/lmnr-pi-extension/src/index.ts
```

…or install it as a discovered extension (directory package with `package.json` +
`node_modules`) under `~/.pi/agent/extensions/` (global) or `.pi/extensions/`
(project-local). See `wayfinder/tickets/004` for packaging details.

## Develop

```sh
npm run typecheck    # tsc --noEmit
npm test             # node:test via tsx — unit + end-to-end OTLP-capture tests
```

The end-to-end test (`tests/extension.test.ts`) drives the extension with synthetic pi
events against a local OTLP capture server and asserts the resulting span tree — no network
or Laminar account required.
