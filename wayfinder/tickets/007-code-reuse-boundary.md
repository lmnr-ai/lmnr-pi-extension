---
id: 7
title: "Code-reuse boundary from the Claude Code plugin"
type: grilling
status: open
assignee: null
blockedBy: [2, 4]
---

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
