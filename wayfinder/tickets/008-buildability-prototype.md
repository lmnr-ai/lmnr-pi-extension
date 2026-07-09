---
id: 8
title: "Buildability spike: stub pi extension exporting one live trace"
type: prototype
status: closed
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

## Resolution

**The model is buildable — verified end to end against real pi.** Built as a working
extension (not a throwaway stub, since the decisions were solid): asset is the repo itself
([`src/index.ts`](../../src/index.ts), [`src/tracer.ts`](../../src/tracer.ts),
[`src/attributes.ts`](../../src/attributes.ts), [`src/config.ts`](../../src/config.ts)),
committed to `main`. `npm run typecheck` clean; **10 tests pass** including an end-to-end
test that drives the extension with synthetic pi events against a local OTLP-capture server
and asserts the span tree (`tests/extension.test.ts`).

**Real-pi run (the definitive proof):** `pi -e src/index.ts -p "…"` on `amazon-bedrock`
loaded the extension via jiti (no build) with OTel resolved from `node_modules`, and
exported a live trace — root `pi agent run` (DEFAULT, real session id
`019f4873-…`) with a nested `LLM call (turn 0)` (LLM, model `us.anthropic.claude-opus-4-8`)
— confirming tickets 2/3/4/5 hold against real behavior. A `/code-review` pass ran; its
correctness/spec fixes (input truncation choke point, `pi.turn.index` namespacing, revert of
scope-crept export-timeout override, dedup) were applied.

**Two gaps the spike surfaced (feed the remaining work, not this ticket):**
1. **`gen_ai.input.messages` is only populated for turn 0** (later turns pass `null`).
   Full prior-context reconstruction per LLM span is a build-detail for the final spec.
2. **Root and TOOL spans use wall-clock, not backdated pi timestamps** — because
   `before_agent_start` and `tool_execution_*` events carry **no timestamp field** (only
   messages do). For live emission wall-clock ≈ real time, but ticket 6 / the spec should
   decide whether to source tool timing from elsewhere. Noted on the map.
