---
wayfinder: map
title: "Laminar observability extension for the pi coding agent (v1 spec)"
---

# Laminar observability extension for the pi coding agent (v1 spec)

Local-markdown wayfinder tracker. Tickets live in `./tickets/`; findings/assets in
`./findings/`. Frontier = open tickets whose every `blockedBy` id is closed and whose
`assignee` is null. Refer to tickets by title, not id.

## Destination

A **hand-off-ready spec** for a Laminar observability **pi extension** — a TypeScript
module in `~/.pi/agent/extensions/` that subscribes to pi lifecycle events and emits, live
and in-process, one Laminar trace per agent run (user prompt) with LLM + tool spans,
grouped into a Laminar session by pi's session id, over OTLP/HTTP/JSON — reusing the Claude
Code plugin's emitter. **Done when every build decision is made** (event→span model, span
attributes, config/secrets, packaging/loading, reliability, code-reuse boundary) and nothing
is left to decide before someone writes the extension. This map is **plan-only**: it produces
decisions, not the built extension.

## Notes

- **Domain:** Laminar observability plugin for the pi coding agent — `badlogic/pi-mono`
  (TypeScript, multi-provider). Extension docs:
  https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md
- **Reference implementation:** the Claude Code plugin at `../lmnr-claude-code-plugin`.
  **Reuse** its OTel→OTLP/JSON→Laminar emitter and attribute conventions (`src/tracer.ts`;
  `lmnr.span.type`, `lmnr.span.input/output`, `gen_ai.*`, `lmnr.association.properties.session_id|user_id`).
  Do **NOT** reuse its transcript-scraping half (transcript/turns/deferral/state) — pi's
  event model makes all of it unnecessary.
- **Scope (v1):** lean MVP — linear session → trace-per-agent-run with LLM + tool spans,
  grouped by pi session id. Forks/compaction/subagents/skills are OUT (see Out of scope).
- **Endpoint:** plan/spec to hand off (wayfinder default). No extension code produced by
  this map; when decisions land, a separate build effort writes it.
- **Skills each session should consult:** `/grilling`, `/domain-modeling`, `/prototype`
  (prototype tickets). Read pi's extensions.md and `./findings/001-pi-recon.md` before
  choosing a ticket.
- **Established facts:** see [pi recon findings](./findings/001-pi-recon.md) (session JSONL
  v3 schema; extension event model incl. `turn_end`/`agent_end`/`tool_execution_*`;
  usage+cost pre-computed; async HTTP allowed in handlers).

## Decisions so far

- [Investigate pi architecture, session format & extension model](./tickets/001-investigate-pi-architecture.md) — pi is `badlogic/pi-mono` (TS); sessions are per-project JSONL v3 with typed rows (`session`/`message`/`model_change`) and a `parentId` tree; assistant messages carry structured `model`/`provider`/`usage`(+cost); extensions are async TS modules on `pi.on(event,…)` with `turn_end {turnIndex,message,toolResults}` etc. and can do HTTP — so a live in-process exporter is viable and ~80% of the CC plugin's machinery is unneeded. Full write-up: [findings/001](./findings/001-pi-recon.md).
- [Trace & span model: map pi lifecycle events to Laminar spans](./tickets/002-trace-and-span-model.md) — **1 Laminar trace = 1 pi agent run** (user prompt → N turns, `before_agent_start`→`agent_end`), grouped into a Laminar session by pi session id (`reason` ignored). Spans **flat under the run root** (root DEFAULT → LLM + TOOL spans, `turnIndex` as attribute; no nesting — temporally correct + max CC reuse). **Fully granular realtime** wiring: root on `before_agent_start`/`agent_end`, LLM span on `message_start`/`message_end`, TOOL span on `tool_execution_start`/`_end` keyed by `toolCallId`; bounded per-run open-span map + `agent_end` orphan sweep (fail-open). Backdate all spans to pi timestamps.
- [Extension packaging, loading & build model](./tickets/004-packaging-loading-build-model.md) — **No build step**: pi loads `.ts` directly via **jiti**; extension is a default-export factory `export default (pi) => …`. **Ship as a directory package** (`~/.pi/agent/extensions/<name>/` global or `.pi/extensions/<name>/` project-local) with `package.json` (`type:module`, OTel in **`dependencies`**) + `index.ts` + `node_modules` — **npm deps resolve from local node_modules, so the CC OTel emitter imports port unchanged, no bundling** (Node distribution). Distribute via `pi install` (npm/git); hot-reload via `/reload`. Caveat: compiled-Bun-binary pi can't resolve arbitrary npm deps (`tryNative:false`) — bundle-with-esbuild is the hedge, out for v1. Full write-up: [findings/002](./findings/002-packaging-loading.md).
- [Config & secrets surface for a pi extension](./tickets/003-config-and-secrets-surface.md) — **No `userConfig` manifest** in pi (settings.json only carries extension paths; flags are CLI-only; no `.env` auto-load). Config is **`process.env`**, env-primary: `LMNR_PROJECT_API_KEY` (secret, required — **absent ⇒ fail-open, no export**), `LMNR_BASE_URL` (default `https://api.lmnr.ai`), `LMNR_USER_ID`, `LMNR_DEBUG`, `LMNR_MAX_CHARS` (20000). Precedence CLI-flag > env > default; **key is env-only** (never a flag). Setup = shell-profile export; **closes the CC live-config gap**. Full write-up: [findings/003](./findings/003-config-secrets.md).
- [Span attribute mapping (pi payload → lmnr/gen_ai attributes)](./tickets/005-span-attribute-mapping.md) — Reuse CC's `gen_ai.*`/`lmnr.*` vocabulary. **LLM span:** `gen_ai.system`=inferred vendor from `model` + `gen_ai.provider.name`=pi `provider`; `gen_ai.request/response.model`=`model`; `finish_reasons`=[`stopReason`]; `input/output.messages` JSON (pi `toolCall` blocks → tool_calls); `gen_ai.usage.*` from `input/output/cacheRead/cacheWrite`, `llm.usage.total_tokens`=`totalTokens`. **Cost:** tokens drive Laminar's own derivation; pi's `cost.total` kept under custom `pi.usage.cost_usd` (no double-count). **TOOL span:** name=`toolName`, input=`args`, output=`result`, `isError`→status ERROR. Truncate by `LMNR_MAX_CHARS`. pi divergences noted (usage field names; `toolCall{arguments}`; result on `tool_execution_end`, not in content).

## Not yet specified

<!-- in-scope fog; graduates to tickets as the frontier advances -->

- **The consolidated v1 spec document** (the destination artifact). Assemble once the
  event→span model, attributes, config, packaging, reliability, and reuse-boundary
  decisions have all landed. Not sharp enough to ticket until its inputs exist.
- **Reasoning/thinking content blocks.** pi has `thinking_level_change` and likely emits
  reasoning content; how those map to spans. Revisit once a session with thinking blocks is
  inspected (only text blocks seen so far).

## Out of scope

<!-- ruled beyond the v1 destination; never graduates -->

- **JSONL session-file parser architecture** — the out-of-process alternative to an
  extension. Ruled out by the architecture decision (would reintroduce all the
  transcript-scraping the extension model lets us escape).
- **Fork / branch-tree representation** (the `parentId` DAG, `session_before_fork`/`session_tree`).
- **Compaction handling** (`session_before_compact` / `session_compact`).
- **Subagents / skills nesting** (Claude Code-plugin-style subagent trees).
