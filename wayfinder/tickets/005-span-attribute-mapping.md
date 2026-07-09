---
id: 5
title: "Span attribute mapping (pi payload → lmnr/gen_ai attributes)"
type: grilling
status: closed
assignee: kyanghasglasses@gmail.com
blockedBy: [2]
---

## Question

Given the trace/span model (ticket 2), what exact Laminar attributes does each span carry,
sourced from pi's structured payloads?

Decide the mapping:
- `message.content[]` (user/assistant blocks) → `lmnr.span.input` / `lmnr.span.output` and
  `gen_ai.input.messages` / `gen_ai.output.messages` (JSON strings, CC conventions).
- pi `usage` → `gen_ai.usage.{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}`
  (map pi's `input/output/cacheRead/cacheWrite`).
- **Cost:** pi provides `usage.cost.total`. Laminar derives cost itself — decide whether to
  emit pi's cost (and under what attribute) or drop it to avoid double-counting.
- `provider` / `model` / `stopReason` → span attributes (which keys).
- Tool spans: `toolName`/`args`/`result`/`isError` → `lmnr.span.type=TOOL` input/output.
- Content-block shapes beyond text (tool_call/tool_result) → how represented.

Reuse the CC plugin's attribute vocabulary verbatim where it fits.

## Resolution

Grounded in CC's `emit.ts` (`buildGenerationAttributes`, `getUsageDetailsFromRow`) and a
**real pi assistant-message payload** from a local session. User delegated the calls after
approving decision 1 (multi-provider `gen_ai.system`); recommendations below adopted, cost
flagged for veto.

**pi field-name divergences discovered (build must not assume Anthropic-raw names):** usage
is `{input, output, cacheRead, cacheWrite, totalTokens, cost:{…,total}}` (not the `gen_ai`
names); assistant content blocks are `text` and `toolCall{id,name,arguments}` (not
`tool_use`); a tool's result is **not** in message content — it arrives on the
`tool_execution_end` event `{toolCallId, result, isError}`.

### Root span (`lmnr.span.type=DEFAULT`, the agent run)
- `lmnr.span.input` = `{role:"user", content:<prompt>}` (from `before_agent_start`);
  `lmnr.span.output` = `{role:"assistant", content:<final assistant text>}` (at `agent_end`).
- `lmnr.association.properties.session_id` = pi session id (per ticket 2);
  `…user_id` = `LMNR_USER_ID` if set; `…metadata.source="pi"` (+ optional `cwd`).

### LLM span (`lmnr.span.type=LLM`, per generation)
| Attribute | Source |
|---|---|
| `gen_ai.system` | **inferred vendor** from `model` (`anthropic`/`openai`/`qwen`…), fallback `provider` — decision 1 (C) |
| `gen_ai.provider.name` | pi `provider` (e.g. `amazon-bedrock`) — preserved (decision 1 C) |
| `gen_ai.request.model` / `gen_ai.response.model` | pi `model` verbatim (incl. `us.…` prefix) |
| `gen_ai.request.api` | pi `api` (e.g. `bedrock-converse-stream`), informational |
| `gen_ai.response.finish_reasons` | `[stopReason]` |
| `gen_ai.input.messages` | JSON of messages feeding this generation (prior user/tool-result context) |
| `gen_ai.output.messages` | JSON `[{role:"assistant", content:<text>, tool_calls:[…from toolCall blocks]}]` |
| `gen_ai.usage.input_tokens` | `usage.input` |
| `gen_ai.usage.output_tokens` | `usage.output` |
| `gen_ai.usage.cache_read_input_tokens` | `usage.cacheRead` |
| `gen_ai.usage.cache_creation_input_tokens` | `usage.cacheWrite` |
| `llm.usage.total_tokens` | `usage.totalTokens` (pi gives it directly — no summing needed) |
| `pi.usage.cost_usd` | `usage.cost.total` — **custom key on purpose** |

**Cost decision (flagged for veto):** emit token counts under `gen_ai.usage.*` (Laminar
derives its own cost from these) and put pi's precomputed total under the **custom
`pi.usage.cost_usd`** — NOT under any `gen_ai` cost key — so Laminar's derivation isn't
double-counted, while pi's ground-truth cost (accurate for the actual gateway, e.g. Bedrock)
stays visible for comparison. Per-component cost dropped for v1. Usage keys kept only when
`> 0` (matches CC's `getUsageDetailsFromRow`).

### TOOL span (`lmnr.span.type=TOOL`), from `tool_execution_start/_end`
- span **name** = `toolName`; `lmnr.span.input` = JSON(`args`); `lmnr.span.output` =
  JSON(`result`).
- `isError === true` → set span **status ERROR** (`SpanStatusCode.ERROR`); else OK.
- `gen_ai.tool.name` = `toolName`; `gen_ai.tool.call.id` = `toolCallId`; `turnIndex` attribute
  (ticket 2).

### Common
- **Truncate** every text input/output by `LMNR_MAX_CHARS` (default 20000, ticket 3) via CC's
  `truncateText`; serialize via CC's `jsonDumps`. Reuse CC's `SPAN_TYPE/INPUT/OUTPUT_ATTR`,
  `ASSOC_PREFIX`, and the `gen_ai.usage.*` key names verbatim.
- Content-block mapping: `text` → text; `toolCall{id,name,arguments}` → a `tool_call` entry
  in the assistant output message. (`thinking`/reasoning blocks remain map fog — see map.)
