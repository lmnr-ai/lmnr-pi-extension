import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildLlmAttributes,
  buildOutputMessage,
  buildToolDefinitions,
  dumpInputMessages,
  inferVendor,
  mapUsageCost,
  mapUsageTokens,
} from "../src/attributes.js";
import { systemMessage } from "../src/messages.js";
import type { PiAssistantMessage } from "../src/types.js";

test("inferVendor picks the model vendor over the gateway provider", () => {
  assert.equal(inferVendor("us.anthropic.claude-opus-4-8", "amazon-bedrock"), "anthropic");
  assert.equal(inferVendor("us.openai.gpt-5.5", "amazon-bedrock"), "openai");
  assert.equal(inferVendor("amazon-bedrock/qwen.qwen3-coder-480b", "amazon-bedrock"), "qwen");
});

test("inferVendor falls back to provider, then unknown", () => {
  assert.equal(inferVendor(undefined, "amazon-bedrock"), "amazon-bedrock");
  assert.equal(inferVendor("some-unlabeled-model", undefined), "unknown");
  assert.equal(inferVendor(undefined, undefined), "unknown");
});

test("mapUsageTokens maps pi field names and drops zeros", () => {
  const out = mapUsageTokens({ input: 2, output: 89, cacheRead: 0, cacheWrite: 8209, totalTokens: 8300 });
  assert.deepEqual(out, {
    "gen_ai.usage.input_tokens": 2,
    "gen_ai.usage.output_tokens": 89,
    "gen_ai.usage.cache_creation_input_tokens": 8209,
    "llm.usage.total_tokens": 8300,
  });
  assert.ok(!("gen_ai.usage.cache_read_input_tokens" in out), "zero cacheRead dropped");
});

test("mapUsageTokens passes through the reasoning and 1h-cache splits", () => {
  const out = mapUsageTokens({ input: 2, output: 89, reasoning: 40, cacheWrite: 8209, cacheWrite1h: 1000 });
  assert.equal(out["gen_ai.usage.reasoning_tokens"], 40);
  assert.equal(out["gen_ai.usage.cache_creation.input_tokens.ephemeral_1h"], 1000);
  assert.equal(out["gen_ai.usage.cache_creation_input_tokens"], 8209);
});

test("mapUsageCost folds cache costs into input_cost so the breakdown sums to the total", () => {
  // Real proportions from a pi turn: cache write dwarfs fresh input. pi computes
  // total as input + output + cacheRead + cacheWrite (pi-ai `calculateCost`).
  const cost = { input: 0.00001, cacheRead: 0.0012, cacheWrite: 0.0365, output: 0.001175, total: 0.038885 };
  const out = mapUsageCost({ cost });

  assert.equal(out["gen_ai.usage.input_cost"], 0.00001 + 0.0012 + 0.0365);
  assert.equal(out["gen_ai.usage.output_cost"], 0.001175);
  assert.equal(out["gen_ai.usage.cost"], 0.038885);
  const summed = out["gen_ai.usage.input_cost"] + out["gen_ai.usage.output_cost"];
  assert.ok(
    Math.abs(summed - out["gen_ai.usage.cost"]) < 1e-9,
    `input + output (${summed}) must equal the total pi reported (${out["gen_ai.usage.cost"]})`
  );
});

test("buildOutputMessage renders text + toolCall blocks as Anthropic content", () => {
  const msg: PiAssistantMessage = {
    role: "assistant",
    stopReason: "toolUse",
    content: [
      { type: "text", text: "running it" },
      { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
    ],
  };
  // The stop reason stays on `gen_ai.response.finish_reasons`, not the message.
  assert.deepEqual(buildOutputMessage(msg), {
    role: "assistant",
    content: [
      { type: "text", text: "running it" },
      { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
    ],
  });
});

test("buildToolDefinitions maps pi tools to the shape Laminar's tools column reads", () => {
  const params = { type: "object", properties: { command: { type: "string" } } };
  assert.deepEqual(
    buildToolDefinitions([
      { name: "bash", description: "Execute a command", parameters: params },
      { name: "read" },
    ]),
    [
      { name: "bash", description: "Execute a command", parameters: params },
      { name: "read", description: "", parameters: {} },
    ]
  );
});

test("dumpInputMessages: a leading system message does not eat the conversation budget", () => {
  // A system prompt far larger than the budget — the real pi case, where it runs
  // ~12k against a 20k default. On a single shared budget it would swallow the
  // whole payload and the conversation would never appear.
  const messages = [
    systemMessage("S".repeat(5000)),
    { role: "user", content: [{ type: "text", text: "list the files" }] },
    { role: "assistant", content: [{ type: "text", text: "here they are" }] },
  ];
  const parsed = JSON.parse(dumpInputMessages(messages, 600));

  assert.equal(parsed.length, 3, "system message plus both conversation turns survive");
  assert.equal(parsed[0].role, "system");
  assert.equal(parsed[1].content[0].text, "list the files", "the conversation keeps its own budget");
  assert.equal(parsed[2].content[0].text, "here they are", "the latest turn is not clipped");
});

test("dumpInputMessages: the system prompt is itself capped, and no system message is a no-op", () => {
  const long = JSON.parse(dumpInputMessages([systemMessage("S".repeat(5000))], 100));
  assert.match(long[0].content[0].text, /^S{100}… \[truncated 4900 chars\]$/);

  const conversation = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
  assert.equal(dumpInputMessages(conversation, 600), JSON.stringify(conversation));
});

test("buildLlmAttributes: cost uses the SDK's canonical gen_ai.usage.cost keys", () => {
  const msg: PiAssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    provider: "amazon-bedrock",
    model: "us.anthropic.claude-opus-4-8",
    api: "bedrock-converse-stream",
    stopReason: "toolUse",
    usage: {
      input: 2,
      output: 89,
      cacheWrite: 8209,
      totalTokens: 8300,
      cost: { input: 0.05, output: 0.0035, total: 0.0535 },
    },
  };
  const attrs = buildLlmAttributes(msg, null);
  assert.equal(attrs["gen_ai.system"], "anthropic");
  assert.equal(attrs["gen_ai.provider.name"], "amazon-bedrock");
  assert.equal(attrs["gen_ai.request.model"], "us.anthropic.claude-opus-4-8");
  assert.deepEqual(attrs["gen_ai.response.finish_reasons"], ["toolUse"]);
  assert.equal(attrs["gen_ai.usage.input_tokens"], 2);
  // pi's authoritative cost is emitted under the canonical SDK keys.
  assert.equal(attrs["gen_ai.usage.cost"], 0.0535);
  assert.equal(attrs["gen_ai.usage.input_cost"], 0.05);
  assert.equal(attrs["gen_ai.usage.output_cost"], 0.0035);
});

test("buildLlmAttributes: cost keys omitted when pi reports no cost", () => {
  const msg: PiAssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    model: "us.anthropic.claude-opus-4-8",
    usage: { input: 2, output: 89, totalTokens: 91 },
  };
  const attrs = buildLlmAttributes(msg, null);
  assert.ok(!Object.keys(attrs).some((k) => k.startsWith("gen_ai.usage.cost")));
});
