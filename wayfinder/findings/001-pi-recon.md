# Findings: pi coding agent — architecture, session format, extension model

Reconnaissance that grounded the map. Sources: local `~/.pi/agent/`, pi's
[extensions docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md),
HF [agent trace viewer changelog](https://huggingface.co/changelog/agent-trace-viewer).

## What pi is

`badlogic/pi-mono` (Mario Zechner) — a TypeScript, multi-provider coding agent.
Local `~/.pi/agent/settings.json` shows `defaultProvider: amazon-bedrock`,
models incl. `claude-opus-4-8`, `gpt-5.5`, `qwen3-coder`. Has `skills/`.
HF's trace viewer ingests `~/.pi/agent/sessions/*.jsonl` directly, alongside
Claude Code (`~/.claude/projects`), Codex (`~/.codex/sessions`), Factory Droid
(`~/.factory/sessions`).

## Session storage & format (JSONL v3)

- One JSONL file per session: `~/.pi/agent/sessions/<escaped-project-path>/<ISO-ts>_<uuidv7>.jsonl`
  (project dirs escaped like Claude Code's).
- Typed rows by `type`: `session`, `model_change`, `thinking_level_change`, `message`.
- `session` row: `{ type, version:3, id, timestamp, cwd }` — `id` is the session's uuidv7.
- Messages form a **tree** via `parentId` (pi supports fork / compact / tree navigation).
- `message` row: `{ type, id, parentId, timestamp, message }`.
  - user: `message = { role:"user", content:[{type:"text",…}], timestamp }`
  - assistant: `message = { role:"assistant", content:[…], api, provider, model, stopReason, usage, timestamp }`
- **Usage AND cost are pre-computed** on each assistant message:
  ```json
  "usage": { "input":5384, "output":169, "cacheRead":0, "cacheWrite":0,
             "totalTokens":5553,
             "cost": { "input":…, "output":…, "cacheRead":0, "cacheWrite":0, "total":0.00148868 } }
  ```
  (No gen_ai reconstruction or cost math needed — pi hands both over.)

## Extension system (the load-bearing capability)

- TS modules in `~/.pi/agent/extensions/` (global) or `.pi/extensions/` (project-local),
  auto-discovered, hot-reloadable via `/reload`.
- Registration: `export default function (pi) { pi.on("event", async (event, ctx) => { … }) }`.
- **Handlers are async and CAN do HTTP fetches during event processing** (confirmed in docs) —
  so a live in-process Laminar exporter is viable.
- Config: `process.env.*`; persist state via `pi.appendEntry(type, data)`, read via
  `ctx.sessionManager.getEntries()`. (No confirmed per-extension `userConfig`-style
  manifest like Claude Code's `plugin.json` — see ticket on config surface.)

### Lifecycle events that matter for tracing
- `session_start` `{ reason:"startup"|"reload"|"new"|"resume"|"fork", previousSessionFile? }`
- `before_agent_start` `{ prompt, images, systemPrompt, systemPromptOptions:{…} }`
- `agent_start` (minimal) / `agent_end` `{ messages }` / `agent_settled`
- `turn_start` `{ turnIndex, timestamp }` / **`turn_end` `{ turnIndex, message, toolResults }`** ← assembled turn
- `message_start` / `message_update` / `message_end` `{ message }`
- `tool_execution_start` `{ toolCallId, toolName, args }` /
  `tool_execution_end` `{ toolCallId, toolName, result, isError }`
- `session_shutdown` `{ reason }`

## Implications for the plugin (vs the Claude Code plugin)

The CC plugin spent ~80% of its complexity on the Stop/SessionEnd shell-out model:
byte-offset transcript scraping, incremental buffering, turn assembly, the flush race,
the at-least-once state file. **As a pi extension all of that disappears** — pi delivers
assembled turns (`turn_end`), structured model/usage/cost, and async in-process export.

The CC plugin's OTHER half — the OTel-SDK → OTLP/JSON → Laminar emitter with the
`lmnr.span.type` / `gen_ai.*` / `lmnr.association.properties.session_id|user_id`
conventions (`../lmnr-claude-code-plugin/src/tracer.ts` + emit conventions) — is
**directly reusable**. The transcript/turn/deferral/state modules are NOT.
