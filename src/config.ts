import * as os from "node:os";
import * as path from "node:path";

// ----------------- Configuration (env-primary) -----------------
// No pi `userConfig` manifest exists, so config comes from process.env. We reuse
// the plain LMNR_* names (Laminar's SDK convention). Debugger/rollout-session
// resolution used to live here; the SDK now owns it (see tracer.initTracing).

/** Read a plain env var, trimmed; "" when absent. */
function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

// Gate for the extension's own debug-level file logging (see logger.ts). The SDK
// reads LMNR_DEBUG itself to drive the debugger session — this is separate.
export const DEBUG = env("LMNR_DEBUG").toLowerCase() === "true";

const DEFAULT_MAX_CHARS = 20000;

function parseMaxChars(): number {
  const n = Number.parseInt(env("LMNR_MAX_CHARS"), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_CHARS;
}
export const MAX_CHARS = parseMaxChars();

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
