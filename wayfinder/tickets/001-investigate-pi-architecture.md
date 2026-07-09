---
id: 1
title: "Investigate pi architecture, session format & extension model"
type: research
status: closed
assignee: null
blockedBy: []
---

## Question

What is the pi coding agent, how does it store sessions, and what extension/hook
mechanism can a Laminar observability plugin attach to? Enough to name the destination
and chart the frontier.

## Resolution

pi = `badlogic/pi-mono` (TypeScript, multi-provider). Sessions are per-project JSONL v3
(`~/.pi/agent/sessions/<project>/<ts>_<uuidv7>.jsonl`) with typed rows
(`session`/`message`/`model_change`/`thinking_level_change`) forming a `parentId` tree;
assistant messages carry structured `provider`/`model`/`stopReason`/`usage` **with
pre-computed cost**. pi has a first-class **extension system**: async TS modules in
`~/.pi/agent/extensions/`, `pi.on(event, async (e, ctx) => …)`, handlers may perform HTTP
I/O. Relevant events: `session_start`, `before_agent_start`, `turn_end
{turnIndex,message,toolResults}`, `agent_end {messages}`, `tool_execution_start/end`,
`session_shutdown`. HF's trace viewer already ingests pi sessions.

Consequence: a **live in-process extension** is viable and drops ~80% of the Claude Code
plugin's machinery; the CC emitter half is reusable. Full write-up:
[../findings/001-pi-recon.md](../findings/001-pi-recon.md).
