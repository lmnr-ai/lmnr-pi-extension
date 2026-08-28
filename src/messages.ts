import type { Json } from "./types.js";

// ----------------- pi messages → Anthropic-style chat messages -----------------
// Every Laminar instrumentation reports `gen_ai.input.messages` /
// `gen_ai.output.messages` as `{role, content}`. The ones that carry reasoning —
// notably the Claude Code proxy, which ships raw Anthropic payloads — keep the
// reasoning as a STRUCTURED block inside the content array rather than flattening
// it into the answer text. We match that: the same envelope as every other
// instrumentation, and thinking stays something you can tell apart from the reply.
//
//   pi block                                  Anthropic block
//   {type:"text",     text}                →  {type:"text",     text}
//   {type:"thinking", thinking}            →  {type:"thinking", thinking}
//   {type:"toolCall", id, name, arguments} →  {type:"tool_use",  id, name, input}
//   role "toolResult"                      →  role "user" + {type:"tool_result", …}
//
// The block shapes are not free-form. Laminar's parser matches a CLOSED union of
// Anthropic block types (`AnthropicContentBlockSchema`), with no passthrough
// branch: one unrecognized block fails its message, which fails the whole array
// and drops the payload to the generic renderer. Only emit shapes in that union.

/** An Anthropic-style chat message: a role plus a list of content blocks. */
export interface ChatMessage {
  role: string;
  content: Json[];
}

/** Map one pi content block to its Anthropic block, or null when it carries nothing. */
function blockToContent(block: Json): Json | null {
  if (!block || typeof block !== "object") {
    return null;
  }
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? { type: "text", text: block.text } : null;
    case "thinking":
      return typeof block.thinking === "string" ? { type: "thinking", thinking: block.thinking } : null;
    case "toolCall":
      return { type: "tool_use", id: block.id, name: block.name, input: block.arguments ?? {} };
    case "image":
      // Anthropic's image block requires the base64 payload, and pi keeps an
      // image in context for the rest of the run — carrying it would repeat
      // hundreds of KB on every later turn. Report that an image was there, and
      // its type, instead of re-embedding the bytes.
      return { type: "text", text: `[image${typeof block.mimeType === "string" ? ` ${block.mimeType}` : ""}]` };
    default:
      return null;
  }
}

/** Map a pi content array (or bare string) to Anthropic content blocks. */
export function contentToBlocks(content: Json): Json[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const blocks: Json[] = [];
  for (const block of content) {
    const mapped = blockToContent(block);
    if (mapped) {
      blocks.push(mapped);
    }
  }
  return blocks;
}

/**
 * Map one pi message to a chat message, or null when there is nothing to say.
 *
 * pi delivers more roles than the three chat roles: `toolResult` for tool output,
 * and `custom` / `bashExecution` / … for content pi and its extensions inject
 * into the context. Those last ones really were part of the request, so they are
 * reported as user messages tagged with their origin rather than dropped.
 */
export function toChatMessage(message: Json): ChatMessage | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  switch (message.role) {
    case "user":
    case "assistant": {
      const content = contentToBlocks(message.content);
      return content.length > 0 ? { role: message.role, content } : null;
    }
    case "toolResult": {
      const block: Json = {
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: contentToBlocks(message.content),
      };
      if (message.isError) {
        block.is_error = true;
      }
      // Anthropic carries tool results on a USER message, and Laminar's parser
      // accepts only user/assistant/system — a "tool" role would fail to parse.
      return { role: "user", content: [block] };
    }
    default: {
      const content = contentToBlocks(message.content);
      if (content.length === 0) {
        return null;
      }
      const origin = typeof message.customType === "string" ? message.customType : message.role;
      return { role: "user", content: [{ type: "text", text: `[pi:${origin}]` }, ...content] };
    }
  }
}

/** Map pi's context-event message list to chat messages. */
export function toChatMessages(messages: Json[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const message of messages ?? []) {
    const mapped = toChatMessage(message);
    if (mapped) {
      out.push(mapped);
    }
  }
  return out;
}

/**
 * The run's system prompt as the message that heads a turn's input. Content is a
 * block array rather than a bare string, matching the Claude Code proxy — and
 * the server reads either when it fingerprints the prompt (`prompt_hash`).
 */
export function systemMessage(systemPrompt: string): ChatMessage {
  return { role: "system", content: [{ type: "text", text: systemPrompt }] };
}
