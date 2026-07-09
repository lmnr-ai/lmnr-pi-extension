---
id: 8
title: "Buildability spike: stub pi extension exporting one live trace"
type: prototype
status: open
assignee: kyanghasglasses@gmail.com
blockedBy: [4]
---

## Question

Is the ticket-2 event→span model actually buildable as a real pi extension, end to end,
before we commit it to the hand-off spec?

Build a **thin throwaway stub** (`/prototype`) that, against a real local pi session:
- registers on the granular lifecycle events decided in
  [ticket 2](./002-trace-and-span-model.md) — `before_agent_start`/`agent_end` (root),
  `message_start`/`message_end` (LLM span), `tool_execution_start`/`_end` keyed by
  `toolCallId` (TOOL span);
- holds the bounded per-run open-span map and closes/drops orphans on `agent_end`;
- exports via the reused OTel→OTLP/JSON emitter and **produces one visible Laminar trace**
  (1 agent run → LLM + TOOL spans, flat under the root) grouped by pi session id.

Goal is confidence, not completeness — no full attribute mapping (ticket 5) or hardened
reliability (ticket 6) needed. Confirm the load/build path (ticket 4) works, the events
fire in the assumed order, `toolCallId` correlation holds (incl. parallel tools), and a
span actually lands in Laminar. Surface any gap between the assumed event model and pi's
real behavior back into ticket 2 / the spec. Link the stub as an asset.

Blocked by [ticket 4] (packaging/loading/build): can't stand up or run a stub extension —
or know whether the OTel npm deps import — until the load model is settled.
