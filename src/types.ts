// pi event payloads are dynamic JSON objects whose exact shape is internal to
// the pi coding agent, so we treat them as loosely-typed records. `Json` is any
// parsed JSON value. (Mirrors the CC plugin's types.ts.)
export type Json = any;

// ---- pi payload shapes we actually read (documented in wayfinder/findings) ----

/** pi assistant message usage block (see findings/001, findings/005). */
export interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Subset of cacheWrite written with 1h retention (Anthropic only). */
  cacheWrite1h?: number;
  /** Reasoning tokens, when the provider reports them. A subset of `output`. */
  reasoning?: number;
  totalTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
}

/** A pi tool as reported by `pi.getAllTools()` (name, description, JSON schema). */
export interface PiToolInfo {
  name: string;
  description?: string;
  parameters?: Json;
}

/** A pi assistant `message` (the `message` field of a `turn_end`/`message_end` event). */
export interface PiAssistantMessage {
  role: "assistant";
  content: Json[];
  api?: string;
  provider?: string;
  model?: string;
  /** "stop" | "length" | "toolUse" | "error" | "aborted". */
  stopReason?: string;
  errorMessage?: string;
  usage?: PiUsage;
}

/** pi stop reasons that mean the turn did not complete normally. */
export const FAILED_STOP_REASONS = new Set(["error", "aborted"]);
