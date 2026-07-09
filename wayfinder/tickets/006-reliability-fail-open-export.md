---
id: 6
title: "Reliability & fail-open export model"
type: grilling
status: open
assignee: null
blockedBy: [2]
---

## Question

> Constrained by [ticket 2](./002-trace-and-span-model.md): the model is **fully granular,
> realtime** — spans open on start events and close on end events, and export happens
> per-span-end (not batched per turn). So this ticket decides the *mechanism* of live
> export (export-on-close cadence, fire-and-forget vs awaited-with-timeout, the `agent_end`
> /`session_shutdown` orphan sweep for spans open at a mid-run crash), not whether to
> export per-turn vs per-run — that's settled.

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
