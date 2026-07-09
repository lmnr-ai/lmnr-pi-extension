import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildLlmAttributes,
  buildOutputMessage,
  buildRootAssociation,
  inferVendor,
  mapUsageTokens,
} from "../src/attributes.js";
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

test("buildOutputMessage renders text + toolCall blocks", () => {
  const msg: PiAssistantMessage = {
    role: "assistant",
    content: [
      { type: "text", text: "running it" },
      { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
    ],
  };
  assert.deepEqual(buildOutputMessage(msg), {
    role: "assistant",
    content: "running it",
    tool_calls: [{ id: "t1", name: "bash", arguments: { command: "ls" } }],
  });
});

test("buildLlmAttributes: cost is custom-keyed, never a gen_ai cost key", () => {
  const msg: PiAssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    provider: "amazon-bedrock",
    model: "us.anthropic.claude-opus-4-8",
    api: "bedrock-converse-stream",
    stopReason: "toolUse",
    usage: { input: 2, output: 89, cacheWrite: 8209, totalTokens: 8300, cost: { total: 0.0535 } },
  };
  const attrs = buildLlmAttributes(msg, null);
  assert.equal(attrs["gen_ai.system"], "anthropic");
  assert.equal(attrs["gen_ai.provider.name"], "amazon-bedrock");
  assert.equal(attrs["gen_ai.request.model"], "us.anthropic.claude-opus-4-8");
  assert.deepEqual(attrs["gen_ai.response.finish_reasons"], ["toolUse"]);
  assert.equal(attrs["pi.usage.cost_usd"], 0.0535);
  assert.equal(attrs["gen_ai.usage.input_tokens"], 2);
  // No gen_ai.* cost key that Laminar would double-count.
  assert.ok(!Object.keys(attrs).some((k) => k.startsWith("gen_ai.usage.cost")));
});

test("buildRootAssociation sets session_id, source, and optional user_id", () => {
  assert.deepEqual(buildRootAssociation("sess-1", null), {
    "lmnr.association.properties.session_id": "sess-1",
    "lmnr.association.properties.metadata.source": "pi",
  });
  const withUser = buildRootAssociation("sess-1", "user-9", "/work");
  assert.equal(withUser["lmnr.association.properties.user_id"], "user-9");
  assert.equal(withUser["lmnr.association.properties.metadata.cwd"], "/work");
});
