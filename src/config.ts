import * as os from "node:os";
import * as path from "node:path";

// ----------------- Configuration (wayfinder ticket 3: env-primary) -----------------
// No pi `userConfig` manifest exists, so config comes from process.env. We reuse
// the plain LMNR_* names (Laminar's SDK convention; the CC plugin honored them as
// its primary fallback) and drop CC's CLAUDE_PLUGIN_OPTION_/CC_ layers.

/** Read a plain env var, trimmed; "" when absent. */
function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

export const DEBUG = env("LMNR_DEBUG").toLowerCase() === "true";

const DEFAULT_MAX_CHARS = 20000;

function parseMaxChars(): number {
  const n = Number.parseInt(env("LMNR_MAX_CHARS"), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_CHARS;
}
export const MAX_CHARS = parseMaxChars();

// Cap for a single OTLP export request (connect + response), in seconds.
// A constant for v1 (ticket 3; ticket 6 confirms).
export const EXPORT_TIMEOUT_S = 5.0;

/** Absolute path to the extension's debug log (pi is a TUI — never log to stdout/stderr). */
export function logFile(): string {
  return path.join(os.homedir(), ".pi", "agent", "lmnr-pi-extension.log");
}

export interface LaminarConfig {
  apiKey: string;
  baseUrl: string;
  userId: string | null;
}

/** Resolve Laminar config from env, or null when the API key is absent (fail-open). */
export function getLaminarConfig(): LaminarConfig | null {
  const apiKey = env("LMNR_PROJECT_API_KEY");
  const baseUrl = (env("LMNR_BASE_URL") || "https://api.lmnr.ai").replace(/\/+$/, "");
  const userId = env("LMNR_USER_ID") || null;
  if (!apiKey) {
    return null;
  }
  return { apiKey, baseUrl, userId };
}
