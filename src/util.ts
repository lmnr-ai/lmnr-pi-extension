import type { Json } from "./types.js";

/** JSON.stringify with a fallback for non-serializable values. */
export function jsonDumps(value: Json): string {
  return JSON.stringify(value, (_key, v) => {
    if (typeof v === "bigint" || typeof v === "symbol" || typeof v === "function") {
      return String(v);
    }
    return v;
  });
}

/** Extract concatenated text from a pi content array (text blocks only). */
export function extractText(content: Json): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}
