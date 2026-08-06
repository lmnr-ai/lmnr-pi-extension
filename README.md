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
per-turn input/output messages (`gen_ai.*`), the active tool definitions, and the run's
session id — so runs are grouped and cost-attributed in the Laminar UI without any extra
setup.

### What each LLM span reports

**The messages Pi actually sent.** `gen_ai.input.messages` comes from Pi's `context` event,
which fires before every LLM call and carries the list Pi assembled — full session history,
compaction already applied, extension-injected messages included. We report that list rather
than reconstruct one from the event stream.

**The system prompt**, as the `role: "system"` message heading every turn — the prompt Pi
actually sent, after each `before_agent_start` handler has had its say. It runs about 12k
chars, so it gets its own `LMNR_MAX_CHARS` budget rather than sharing the conversation's;
otherwise it would clip the turns.

**The active tool definitions**, as `gen_ai.tool.definitions` — name, description and JSON
schema for each tool in the run, filtered to Pi's active set. Laminar reads these off LLM
spans into its canonical tool-definitions column and content-addresses them, so repeating
the same set on every turn costs one stored row.

Messages are `{role, content: [blocks]}` with Anthropic-style content blocks — the same shape
every other Laminar instrumentation reports, so pi traces read like Claude Code's. Pi's
content blocks map onto Anthropic blocks one for one:

| Pi | Laminar |
| --- | --- |
| `{type: "text", text}` | `{type: "text", text}` |
| `{type: "thinking", thinking}` | `{type: "thinking", thinking}` |
| `{type: "toolCall", id, name, arguments}` | `{type: "tool_use", id, name, input}` |
| role `toolResult` | role `user` + `{type: "tool_result", tool_use_id, content}` |

Reasoning stays a **structured block** rather than being flattened into the reply text, so a
reader can still tell the model's thinking from its answer. Images are reported as
`[image <mime type>]` rather than re-embedded: Anthropic's image block requires the base64
payload, and Pi keeps an image in context for the rest of the run, so carrying it would
repeat hundreds of KB on every later turn.

## Configuration

Configuration comes from the environment, falling back to `~/.config/lmnr/pi-extension.json`
(`{ "projectApiKey": "...", "baseUrl": "..." }`, mode 0600) written by
`lmnr-cli plugin add pi`. The environment wins, so you can redirect a single run without
editing the file.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `LMNR_PROJECT_API_KEY` | yes | config file | Laminar project API key. Absent from both ⇒ tracing disabled (fail-open). |
| `LMNR_BASE_URL` | no | config file, else `https://api.lmnr.ai` | Laminar API base URL (self-hosted deployments). |
| `LMNR_USER_ID` | no | `lmnr-cli login` identity | Associates every trace with a user id. Falls back to the email (then user id) that `lmnr-cli login` stored in `credentials.json`, so a logged-in user is attributed with no config. |
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
