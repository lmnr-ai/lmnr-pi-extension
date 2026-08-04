# Laminar Pi extension

[Laminar](https://www.lmnr.ai) observability for the [Pi coding agent](https://github.com/badlogic/pi-mono).

This extension subscribes to Pi's lifecycle events and emits, **live and in-process**, one
Laminar trace per agent run — with LLM and tool spans — grouped into a Laminar session by
Pi's session id. Tracing, export, and debugger sessions are all handled by the
[`@lmnr-ai/lmnr`](https://www.npmjs.com/package/@lmnr-ai/lmnr) SDK.

## Installation

```sh
npx lmnr-cli@latest plugin add pi
```

The CLI logs you in, lets you pick the Laminar project that should receive your Pi traces,
mints a project API key, writes it to `~/.config/lmnr/pi-extension.json`, and runs
`pi install npm:@lmnr-ai/pi-extension`. Restart Pi and every run is traced.

Prefer to wire it up by hand? Install the package and set the key in your environment:

```sh
pi install npm:@lmnr-ai/pi-extension
export LMNR_PROJECT_API_KEY="..."
```

Without a key from either source, the extension disables itself and Pi runs untouched
(fail-open).

## What you get

One Laminar **trace = one Pi agent run** (`before_agent_start` → `agent_end`). Spans open on
start events and close on end events — fully granular and realtime — under the run root:

```
pi agent run            (DEFAULT)   ← before_agent_start / agent_end
├─ LLM call (turn 0)    (LLM)       ← message_start / message_end
├─ bash                 (TOOL)      ← tool_execution_start / tool_execution_end
├─ LLM call (turn 1)    (LLM)
└─ …
```

Each span carries the Laminar-native attributes: token usage and cost, model/provider,
per-turn input/output messages (`gen_ai.*`), and the run's session id — so runs are grouped
and cost-attributed in the Laminar UI without any extra setup.

## Configuration

Configuration comes from the environment, falling back to `~/.config/lmnr/pi-extension.json`
(`{ "projectApiKey": "...", "baseUrl": "..." }`, mode 0600) written by
`lmnr-cli plugin add pi`. The environment wins, so you can redirect a single run without
editing the file.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `LMNR_PROJECT_API_KEY` | yes | config file | Laminar project API key. Absent from both ⇒ tracing disabled (fail-open). |
| `LMNR_BASE_URL` | no | config file, else `https://api.lmnr.ai` | Laminar API base URL (self-hosted deployments). |
| `LMNR_USER_ID` | no | — | Associates every trace with a user id. |
| `LMNR_MAX_CHARS` | no | `20000` | Truncation cap for span input/output values. |
| `LMNR_DEBUG` | no | — | Enables debugger sessions + file logging to `~/.pi/agent/lmnr-pi-extension.log`. |
| `LMNR_DEBUG_SESSION_ID` | no | — | Explicit debugger (rollout) session id. |

## Debugger sessions

With `LMNR_DEBUG` set to a truthy value, each run is associated with a Laminar **debugger
session** so it shows up in the debugger UI. The session id is resolved by the SDK:
`LMNR_DEBUG_SESSION_ID` → the nearest `.lmnr/debug-session.json` (written by
`lmnr-cli debug session new`) → a freshly minted id. The SDK registers the session and stamps
it on every span.

## Development

```sh
npm install
npm run typecheck    # tsc --noEmit
npm test             # node:test via tsx — unit + end-to-end span-tree tests
```

The end-to-end test (`tests/extension.test.ts`) drives the extension with synthetic Pi events
against an in-memory span exporter and asserts the resulting span tree — no network or Laminar
account required.

## License

[Apache-2.0](./LICENSE)
