import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ----------------- Configuration (env first, then config file) -----------------
// No Pi `userConfig` manifest exists, so config comes from process.env, falling
// back to the file `lmnr-cli plugin add pi` writes. We reuse the plain LMNR_*
// names (Laminar's SDK convention). Debugger/rollout-session resolution used to
// live here; the SDK now owns it (see tracer.initTracing).
//
// This module must not import ./logger — logger imports DEBUG from here, so an
// import back would be circular. Every failure path is therefore silent.

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

/** Absolute path to the extension's debug log (Pi is a TUI — never log to stdout/stderr). */
export function logFile(): string {
  return path.join(os.homedir(), ".pi", "agent", "lmnr-pi-extension.log");
}

// ----------------- Config file (written by `lmnr-cli plugin add pi`) -----------------
// The CLI mints a project API key and writes it here rather than printing an
// `export` line, so the key never lands in terminal scrollback or shell history.
// Same file shape and location convention as the Claude Code and Codex plugins.

const CONFIG_FILE = "pi-extension.json";

/** Directory holding Laminar's per-user config, matching the CLI's own resolution. */
function globalLmnrDirectory(): string {
  const xdg = env("XDG_CONFIG_HOME");
  if (xdg) {
    return path.join(xdg, "lmnr");
  }
  const appData = env("APPDATA");
  if (process.platform === "win32" && appData) {
    return path.join(appData, "lmnr");
  }
  return path.join(os.homedir(), ".config", "lmnr");
}

/** Absolute path to the config file `lmnr-cli plugin add pi` writes. */
export function configFile(): string {
  return path.join(globalLmnrDirectory(), CONFIG_FILE);
}

interface FileConfig {
  projectApiKey?: unknown;
  baseUrl?: unknown;
}

/** Read the config file. Missing, unreadable, or malformed all yield {} (fail-open). */
function readConfigFile(): FileConfig {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configFile(), "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as FileConfig;
    }
  } catch {
    // No file yet, no permission, or invalid JSON — treat as unconfigured.
  }
  return {};
}

/** A string field from the config file, trimmed; "" when absent or not a string. */
function fileString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export interface LaminarConfig {
  apiKey: string;
  baseUrl: string;
  userId: string | null;
}

/**
 * Resolve Laminar config, or null when no API key is set (fail-open: Pi runs
 * untraced). The environment wins over the config file, so `LMNR_PROJECT_API_KEY`
 * / `LMNR_BASE_URL` can redirect a single run without editing the file.
 */
export function getLaminarConfig(): LaminarConfig | null {
  const envApiKey = env("LMNR_PROJECT_API_KEY");
  const envBaseUrl = env("LMNR_BASE_URL");
  // Only touch the disk when the env leaves something to resolve.
  const file = envApiKey && envBaseUrl ? {} : readConfigFile();

  const apiKey = envApiKey || fileString(file.projectApiKey);
  if (!apiKey) {
    return null;
  }
  const rawBaseUrl = envBaseUrl || fileString(file.baseUrl) || "https://api.lmnr.ai";
  return {
    apiKey,
    baseUrl: rawBaseUrl.replace(/\/+$/, ""),
    userId: env("LMNR_USER_ID") || null,
  };
}
