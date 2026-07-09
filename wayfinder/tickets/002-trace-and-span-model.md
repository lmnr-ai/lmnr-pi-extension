---
id: 2
title: "Trace & span model: map pi lifecycle events to Laminar spans"
type: grilling
status: closed
assignee: kyanghasglasses@gmail.com
blockedBy: [1]
---

## Question

What is the Laminar trace/span shape for a pi session, and which pi events start/end each
span? The core modeling decision every other ticket hangs on.

Decide:
- **Trace boundary:** is one Laminar trace = one *agent run* (a user prompt, spanning N
  turns) or one *turn* (`turn_end`)? The CC plugin did trace-per-turn; pi's `agent` vs
  `turn` split makes agent-run the natural v1 unit. Pick one and justify.
- **Span tree:** what are the spans and how do they nest — root (agent run) → per-turn LLM
  span(s) → tool spans? Which pi events fire start vs end (`before_agent_start`/`agent_start`
  → root; `turn_end` → LLM span; `tool_execution_start`/`_end` → tool spans)?
- **Session grouping:** pi session `id` → `lmnr.association.properties.session_id`. For the
  MVP linear case, how does `session_start` `reason` (`new`/`resume`/`startup`) affect
  grouping (one pi session file = one Laminar session)?
- **Timestamps:** backdate spans to pi's event/message timestamps, as the CC plugin does.

Out of v1 (see map Out of scope): forks/tree, compaction, subagents.

## Resolution

**One Laminar trace = one pi agent run** (one user prompt, spanning all N turns until
the agent settles), grouped into a Laminar session by pi session id. Chosen over
trace-per-turn (the CC plugin's shape): CC had no run boundary to hook, only a scraped
transcript, so a turn was the largest clean unit it could assemble. pi gives us a
first-class run boundary (`before_agent_start` → `agent_end`), so we use it — a run is
what a user recognizes as "the one thing I asked for," and the multi-turn tool loop reads
as one coherent unit. The Laminar session (keyed by pi session id) still ties runs
together, giving a richer two-level hierarchy: **session → trace-per-run → per-turn spans**.

**Span tree — flat under the root** (no per-turn container, no tool-under-LLM nesting):

```
agent run (root, lmnr.span.type=DEFAULT)   input=user prompt, output=final assistant msg
├─ LLM span   (turn 0 generation, type=LLM)
├─ TOOL span  (tool called in turn 0, type=TOOL)
├─ LLM span   (turn 1 generation)
├─ TOOL span  ...
└─ ...
```

Flat chosen for max reuse of CC's emitter (which already builds LLM+TOOL spans flat under
a root — only the root's *meaning* changes from turn to run) and because it is temporally
correct: in pi a generation completes, *then* its tools run, so nesting tools under the
LLM span would put a child outside its parent's time window (reads as broken in a
waterfall). Turn identity is preserved as a **`turnIndex` attribute** on each span, not as
tree structure. Explicit per-turn container spans are a possible later enhancement if the
flat list proves noisy.

**Event → span wiring (fully granular, realtime — spans opened on start events, closed on
end events, exported on close):**

| Span | Open on | Close on | Source of content |
|------|---------|----------|-------------------|
| Root (agent run) | `before_agent_start` (carries `prompt` → input) | `agent_end` (final assistant msg → output) | agent events |
| LLM (per turn) | `message_start` | `message_end` | assistant `message`: content, provider, model, stopReason, usage+cost |
| TOOL | `tool_execution_start` `{toolCallId,toolName,args}` | `tool_execution_end` `{toolCallId,result,isError}` | correlated by `toolCallId` |

Chosen over `turn_end`-only sourcing because **`turn_end` cannot be realtime** — it fires
only once the whole turn (all its tools) has finished, so spans would always lag a full
turn. The user's requirement is live data, so granular is the *only* path, not merely the
richer one. Cost accepted (feeds ticket 6): a bounded per-run map of open span handles
(root + current LLM + one per in-flight `toolCallId`), cleared at `agent_end`; ~6 handlers
vs ~3; parallel-tool event interleaving (handled by `toolCallId` keying); an **`agent_end`
/ `session_shutdown` orphan sweep** to close-or-drop spans still open on a mid-run crash
(fail-open); and export-per-span-end cadence (more, smaller OTLP requests) — the exact
cadence is ticket 6's call, but granular sourcing is what *enables* the live option. This
is live *handle* state (dies with the process), NOT the CC plugin's persisted
byte-offset/transcript state.

**Session grouping:** `lmnr.association.properties.session_id` = **pi session `id`**,
verbatim. `session_start.reason` is *ignored* for grouping — one pi session file = one
Laminar session regardless of how entered (`new`/`resume`/`startup`/`reload`). `resume`
therefore lands pre- and post-resume runs in the same Laminar session (same id). `reason`
may ride along as a debug metadata attribute. Forks (`reason: fork`) are out of scope.

**Timestamps:** backdate every span to pi's real event/message timestamps (start-event
time → span start, end-event time → span end), never wall-clock-at-emit — this keeps
durations truthful despite live emission. Clamp end ≥ start (CC's `SpanHandle.end`
already does this).

**Estimated build (plan-only):** ~+300 lines in the pi extension (handlers + open-span
state map + wiring); reuse `tracer.ts` (~213 lines) as-is; drop CC's
transcript/turns/deferral/state modules entirely. Idiomatic 🟢 (textbook OTel live-span
pattern on pi's native events); bug risk 🟡 (parallel-tool interleaving + orphaned open
spans on mid-run crash — mitigated by `toolCallId` keying + `agent_end` sweep, ticket 6).
