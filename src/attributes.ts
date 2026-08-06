import { LaminarAttributes } from "@lmnr-ai/lmnr";
import { MAX_CHARS } from "./config.js";
import { type ChatMessage, contentToBlocks, systemMessage } from "./messages.js";
import type { Json, PiAssistantMessage, PiToolInfo, PiUsage } from "./types.js";
import { jsonDumps, jsonDumpsTruncated, truncateText } from "./util.js";

// ----------------- Attribute mapping (wayfinder ticket 5) -----------------
// pi payloads → Laminar `lmnr.*` / OTel `gen_ai.*` attributes. Field-name
// divergences from Anthropic-raw are handled here (usage.input vs input_tokens;
// `toolCall{arguments}` blocks; tool result arrives on the event, not content).

/**
 * Infer the model vendor for `gen_ai.system` from pi's `model` string.
 * pi models look like `us.anthropic.claude-opus-4-8`, `us.openai.gpt-5.5`,
 * `amazon-bedrock/qwen.qwen3-coder-...`. We look for a known vendor token,
 * falling back to `provider`, then "unknown".
 */
const KNOWN_VENDORS = ["anthropic", "openai", "google", "meta", "mistral", "cohere", "qwen", "deepseek", "amazon"];

export function inferVendor(model: string | undefined, provider: string | undefined): string {
  const haystack = (model ?? "").toLowerCase();
  for (const vendor of KNOWN_VENDORS) {
    if (haystack.includes(vendor)) {
      return vendor;
    }
  }
  return (provider ?? "").toLowerCase() || "unknown";
}

/** Map pi `usage` token fields to gen_ai.usage.* (kept only when > 0, matching CC). */
export function mapUsageTokens(usage: PiUsage | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!usage) {
    return out;
  }
  const pairs: [string, number | undefined][] = [
    [LaminarAttributes.INPUT_TOKEN_COUNT, usage.input],
    [LaminarAttributes.OUTPUT_TOKEN_COUNT, usage.output],
    // No LaminarAttributes constant for these — use the wire keys Laminar reads.
    ["gen_ai.usage.cache_read_input_tokens", usage.cacheRead],
    ["gen_ai.usage.cache_creation_input_tokens", usage.cacheWrite],
    // Anthropic-only split of cacheWrite by retention, and the reasoning subset
    // of `output` that providers report separately. Both have first-class
    // Laminar attributes, so pass them through when pi has them.
    ["gen_ai.usage.cache_creation.input_tokens.ephemeral_1h", usage.cacheWrite1h],
    ["gen_ai.usage.reasoning_tokens", usage.reasoning],
  ];
  for (const [key, value] of pairs) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      out[key] = value;
    }
  }
  if (typeof usage.totalTokens === "number" && usage.totalTokens > 0) {
    out[LaminarAttributes.TOTAL_TOKEN_COUNT] = usage.totalTokens;
  }
  return out;
}

/**
 * Map pi's precomputed `usage.cost` to the SDK's canonical cost attributes
 * (`gen_ai.usage.cost` / `input_cost` / `output_cost`, per lmnr-ts
 * `LaminarAttributes`). pi hands us the authoritative cost, so we emit it
 * directly rather than relying on Laminar deriving cost from tokens — the
 * derivation only works for models Laminar has pricing for, whereas pi's
 * number is correct for every provider/model.
 *
 * pi splits input cost four ways — fresh input, cache reads, and cache writes
 * (which for a coding agent dominate: a turn can be 1 cent of input and 4 cents
 * of cache write). Laminar stores a three-way breakdown, so the cache costs fold
 * into `input_cost`, where they belong. Reporting `cost.input` alone would leave
 * input + output far short of the total pi already told us.
 */
export function mapUsageCost(usage: PiUsage | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  const cost = usage?.cost;
  if (!cost) {
    return out;
  }
  const num = (value: number | undefined): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  const inputCost = num(cost.input) + num(cost.cacheRead) + num(cost.cacheWrite);
  const pairs: [string, number | undefined][] = [
    [LaminarAttributes.TOTAL_COST, cost.total],
    [LaminarAttributes.INPUT_COST, cost.input === undefined ? undefined : inputCost],
    [LaminarAttributes.OUTPUT_COST, cost.output],
  ];
  for (const [key, value] of pairs) {
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * A pi assistant message as one output chat message. The stop reason is NOT
 * folded in here — it rides `gen_ai.response.finish_reasons`, and an Anthropic
 * message carries no such field.
 */
export function buildOutputMessage(message: PiAssistantMessage): ChatMessage {
  return { role: "assistant", content: contentToBlocks(message.content) };
}

/**
 * Serialize a turn's input messages for `gen_ai.input.messages`.
 *
 * The system prompt gets its own truncation budget. pi's runs about 12k chars —
 * over half of MAX_CHARS — and it is identical on every turn, so charging it to
 * the shared budget would clip the conversation, which is the part that differs
 * between turns and the part worth reading. Both the system message and the
 * conversation therefore get MAX_CHARS each.
 */
export function dumpInputMessages(messages: Json[], maxChars = MAX_CHARS): string {
  const first = messages[0];
  if (first?.role !== "system") {
    return jsonDumpsTruncated(messages, maxChars);
  }
  const text = first.content?.[0]?.text;
  const system = systemMessage(truncateText(String(text ?? ""), maxChars));
  return jsonDumpsTruncated([system, ...messages.slice(1)], maxChars + jsonDumps(system).length);
}

/**
 * Tool definitions for `gen_ai.tool.definitions` — one of the three shapes
 * Laminar's server extracts into the canonical `tool_definitions` column. It
 * only reads them off LLM spans, and it content-addresses the array, so the
 * identical blob repeated on every turn of every run costs one stored row.
 */
export function buildToolDefinitions(tools: PiToolInfo[]): Json[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.parameters ?? {},
  }));
}

/** Attributes for an LLM span, from a pi assistant message. */
export function buildLlmAttributes(message: PiAssistantMessage, inputMessages: Json[] | null): Record<string, Json> {
  const attrs: Record<string, Json> = {
    "gen_ai.system": inferVendor(message.model, message.provider),
  };
  if (message.provider) {
    attrs["gen_ai.provider.name"] = message.provider;
  }
  if (message.model) {
    attrs["gen_ai.request.model"] = message.model;
    attrs["gen_ai.response.model"] = message.model;
  }
  if (message.api) {
    attrs["gen_ai.request.api"] = message.api;
  }
  if (message.stopReason) {
    attrs["gen_ai.response.finish_reasons"] = [message.stopReason];
  }
  if (inputMessages) {
    attrs["gen_ai.input.messages"] = dumpInputMessages(inputMessages);
  }
  attrs["gen_ai.output.messages"] = jsonDumpsTruncated([buildOutputMessage(message)]);

  Object.assign(attrs, mapUsageTokens(message.usage));
  Object.assign(attrs, mapUsageCost(message.usage));
  return attrs;
}
