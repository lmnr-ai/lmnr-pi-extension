# Laminar pi extension

[Laminar](https://www.lmnr.ai) observability for the [pi coding agent](https://github.com/badlogic/pi-mono).

This extension subscribes to pi's lifecycle events and emits, **live and in-process**, one
Laminar trace per agent run — with LLM and tool spans — grouped into a Laminar session by
pi's session id. Tracing, export, and debugger sessions are all handled by the
[`@lmnr-ai/lmnr`](https://www.npmjs.com/package/@lmnr-ai/lmnr) SDK.

## Installation

Add the package to the `packages` array in your pi `settings.json`:

```json
{
  "packages": ["npm:@lmnr-ai/pi-extension"]
}
```

pi installs the package (and its dependencies) and loads it automatically. Then set your
Laminar project API key:

```sh
export LMNR_PROJECT_API_KEY="..."
```

That's it — with the key set, every pi run is traced to Laminar. Without it, the extension
disables itself and pi runs untouched (fail-open).

## What you get

One Laminar **trace = one pi agent run** (`before_agent_start` → `agent_end`). Spans open on
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

All configuration is read from the environment.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `LMNR_PROJECT_API_KEY` | yes | — | Laminar project API key. Absent ⇒ tracing disabled (fail-open). |
| `LMNR_BASE_URL` | no | `https://api.lmnr.ai` | Laminar API base URL (self-hosted deployments). |
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

The end-to-end test (`tests/extension.test.ts`) drives the extension with synthetic pi events
against an in-memory span exporter and asserts the resulting span tree — no network or Laminar
account required.

## License

[Apache-2.0](./LICENSE)
