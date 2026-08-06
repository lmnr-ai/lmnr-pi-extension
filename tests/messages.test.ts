import assert from "node:assert/strict";
import { test } from "node:test";
import { contentToBlocks, toChatMessage, toChatMessages } from "../src/messages.js";

test("contentToBlocks maps pi blocks to Anthropic blocks, thinking kept structured", () => {
  assert.deepEqual(
    contentToBlocks([
      { type: "thinking", thinking: "let me look" },
      { type: "text", text: "hello" },
      { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
    ]),
    [
      // NOT inlined into the text — a reader can still tell reasoning from reply.
      { type: "thinking", thinking: "let me look" },
      { type: "text", text: "hello" },
      { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
    ]
  );
});

test("contentToBlocks reports images without re-embedding the base64", () => {
  assert.deepEqual(contentToBlocks([{ type: "image", data: "…base64…", mimeType: "image/png" }]), [
    { type: "text", text: "[image image/png]" },
  ]);
});

test("contentToBlocks accepts a bare string and drops unknown blocks", () => {
  assert.deepEqual(contentToBlocks("just text"), [{ type: "text", text: "just text" }]);
  // Laminar's Anthropic block union is closed, so an unknown block must not ride
  // along — it would fail its message and drop the whole array to the fallback.
  assert.deepEqual(contentToBlocks([{ type: "somethingNew" }, null, "x"]), []);
  assert.deepEqual(contentToBlocks(undefined), []);
});

test("toChatMessage puts tool results on a user message, Anthropic-style", () => {
  assert.deepEqual(
    toChatMessage({
      role: "toolResult",
      toolCallId: "t1",
      toolName: "bash",
      content: [{ type: "text", text: "a.txt\nb.txt" }],
      isError: false,
    }),
    {
      // "tool" is not an accepted role in Laminar's Anthropic parser.
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a.txt\nb.txt" }] },
      ],
    }
  );
});

test("toChatMessage flags failed tool results", () => {
  const msg = toChatMessage({ role: "toolResult", toolCallId: "t1", content: "boom", isError: true });
  assert.equal(msg!.content[0].is_error, true);
});

test("toChatMessage tags pi- and extension-injected messages instead of dropping them", () => {
  assert.deepEqual(
    toChatMessage({ role: "custom", customType: "plannotator", content: [{ type: "text", text: "note" }] }),
    { role: "user", content: [{ type: "text", text: "[pi:plannotator]" }, { type: "text", text: "note" }] }
  );
});

test("toChatMessages skips messages that carry no content", () => {
  const out = toChatMessages([
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [] },
    { role: "custom", customType: "empty", content: [] },
    null,
  ]);
  assert.deepEqual(out, [{ role: "user", content: [{ type: "text", text: "hi" }] }]);
});
