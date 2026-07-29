---
id: 6
title: "Reliability & fail-open export model"
type: grilling
status: closed
assignee: kyanghasglasses@gmail.com
blockedBy: [2]
---

## Resolution

- **When we export:** per-span-close, fire-and-forget (`void exportWithTimeout(emitter)`),
  with the collecting processor drained on each flush. No per-turn/per-run batching.
- **Fail-open:** every handler is wrapped in try/catch that logs and swallows; the export
  itself is bounded by a timeout and never awaited on pi's critical path, so a Laminar
  outage or slow endpoint can never block or break a pi turn. Verified live (export ran on
  every span close; a bad key/endpoint is swallowed silently).
- **Delivery semantics:** at-most-once accepted — in-process live export removes the CC
  plugin's at-least-once state-file need. A crash mid-turn drops only the open span(s);
  `agent_end` / `session_shutdown` sweep any still-open spans so nothing leaks. No
  byte-offset/state file.
- **Ordering/concurrency:** at most one agent run and one open LLM span at a time; parallel
  tools are keyed by `toolCallId`. No extra serialization needed.

### Prototype findings (ticket 8) — resolved

- **`gen_ai.input.messages` only on turn 0 → FIXED.** The run now keeps a running transcript
  (user prompt → assistant messages incl. tool_calls → tool results); each `message_start`
  snapshots it as that turn's LLM input, so every turn reports its input. Confirmed live
  (turn-1 span input went 0 → 410 chars).
- **`before_agent_start` / `tool_execution_*` carry no timestamp → accepted by design.** For a
  live in-process extension, wall-clock at event receipt *is* the accurate time — events are
  handled synchronously as they occur, so there is nothing to backdate to. Backdating only
  mattered for the CC plugin's after-the-fact transcript scraping. Where pi *does* provide a
  timestamp (assistant messages), we still use it. Observed live durations are sane.

## Question

> Constrained by [ticket 2](./002-trace-and-span-model.md): the model is **fully granular,
> realtime** — spans open on start events and close on end events, and export happens
> per-span-end (not batched per turn). So this ticket decides the *mechanism* of live
> export (export-on-close cadence, fire-and-forget vs awaited-with-timeout, the `agent_end`
> /`session_shutdown` orphan sweep for spans open at a mid-run crash), not whether to
> export per-turn vs per-run — that's settled.

> Prototype input (ticket 8): the working spike exports **per-span-close, fire-and-forget**
> (`void exportWithTimeout`), with a collecting processor drained per flush — real run showed
> 1 span/export. Also found: `before_agent_start`/`tool_execution_*` events carry **no
> timestamp**, so root/TOOL spans currently use wall-clock; decide whether tool timing needs
> another source. Confirm/adjust these against the fail-open requirements below.

How does live in-process export behave so it never blocks a pi turn or breaks pi on a
Laminar outage?

Decide:
- **When** we export: per `turn_end`, per `agent_end`, or buffered/flushed on
  `session_shutdown`? (Live-per-turn was the user's stated preference for the CC plugin.)
- **Fail-open:** a Laminar error / timeout must be swallowed (logged), never thrown into
  pi. Export bounded by a timeout (CC used ~5s) — fire-and-forget vs awaited-with-timeout
  inside the async handler, and whether `ctx.signal` participates.
- **Delivery semantics:** in-process live export removes the CC plugin's at-least-once
  state-file need — confirm we accept at-most-once (a crash mid-turn drops that turn) vs
  any buffering. No byte-offset/state file.
- **Ordering/concurrency:** overlapping turns or rapid events — does anything need
  serialization?
