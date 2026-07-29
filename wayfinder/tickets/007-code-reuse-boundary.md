---
id: 7
title: "Code-reuse boundary from the Claude Code plugin"
type: grilling
status: closed
assignee: kyanghasglasses@gmail.com
blockedBy: [2, 4]
---

## Resolution

- **Reuse:** `src/tracer.ts` — the OTel emitter (`BasicTracerProvider` + collecting
  processor + `exportWithTimeout`) and the emit conventions (`lmnr.span.type`,
  `lmnr.span.input/output`, `gen_ai.*`, `lmnr.association.properties.*`) — ported
  unchanged and confirmed against the attribute-mapping (5) and packaging (4) decisions.
- **Dropped** (pi's event model makes them unnecessary): transcript.ts / turns.ts /
  deferral.ts / state.ts / notifications.ts / subagents.ts.
- **Sharing strategy — decided: keep an independent copy.** `tracer.ts` is vendored
  into this repo rather than extracted into a shared npm package. Rationale: the two
  repos are about to separate; a shared package would couple their release cadences for
  ~250 lines of stable, rarely-changing emitter code. Drift risk is low and acceptable —
  the emit conventions are a frozen contract dictated by Laminar's ingestion, not by
  either agent. Revisit only if the conventions start churning.
- **Module layout (as built):** `index.ts` (pi event wiring) · `tracer.ts` (emitter,
  vendored) · `attributes.ts` (pi→gen_ai/lmnr mapping) · `config.ts` · `util.ts` ·
  `logger.ts` · `types.ts`.

## Question

Exactly which parts of `../lmnr-claude-code-plugin` port into the pi extension, and how is
shared code organized?

Decide:
- **Reuse:** the OTel emitter — `src/tracer.ts` (`BasicTracerProvider` + collecting
  processor + `exportWithTimeout`) and the emit *conventions* (span attributes, session
  association, backdated timestamps). Confirm against the attribute-mapping decision (5)
  and packaging model (4).
- **Drop:** transcript.ts / turns.ts / deferral.ts / state.ts / notifications.ts /
  subagents.ts — the Stop/SessionEnd transcript-scraping machinery pi makes unnecessary.
- **Sharing strategy:** copy the emitter into the pi repo, extract a shared npm package,
  or keep two independent copies? Weigh drift vs coupling for two soon-to-be-separate repos.
- Output: the module layout the hand-off spec prescribes for the extension.
