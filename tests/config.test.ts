import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { configFile, getLaminarConfig } from "../src/config.js";

const KEYS = ["LMNR_PROJECT_API_KEY", "LMNR_BASE_URL", "LMNR_USER_ID", "LMNR_DEBUG", "LMNR_DEBUG_SESSION_ID"];

/** Clear LMNR_* and point config resolution at an empty throwaway config dir, so
 *  a real ~/.config/lmnr/pi-extension.json on the dev's machine can't leak in. */
function clear(): string {
  for (const k of KEYS) {
    delete process.env[k];
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lmnr-pi-cfg-"));
  process.env.XDG_CONFIG_HOME = dir;
  return dir;
}

/** Write a config file where `configFile()` will look for it. */
function writeConfigFile(body: string): void {
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf-8");
}

test("getLaminarConfig returns null without an API key (fail-open)", () => {
  clear();
  assert.equal(getLaminarConfig(), null);
});

test("getLaminarConfig defaults baseUrl and null userId", () => {
  clear();
  process.env.LMNR_PROJECT_API_KEY = "sk-test";
  const cfg = getLaminarConfig();
  assert.deepEqual(cfg, { apiKey: "sk-test", baseUrl: "https://api.lmnr.ai", userId: null });
  clear();
});

/** Write the credentials file `lmnr-cli login` persists. */
function writeCredentials(body: string): void {
  const file = path.join(path.dirname(configFile()), "credentials.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf-8");
}

test("userId falls back to the lmnr-cli logged-in identity", () => {
  clear();
  process.env.LMNR_PROJECT_API_KEY = "sk-test";
  writeCredentials(JSON.stringify({ userEmail: "dev@example.com", userId: "uuid-1" }));
  // Email is preferred over the raw id, matching the CC and Codex plugins.
  assert.equal(getLaminarConfig()?.userId, "dev@example.com");

  writeCredentials(JSON.stringify({ userId: "uuid-1" }));
  assert.equal(getLaminarConfig()?.userId, "uuid-1", "falls back to userId when no email");

  writeCredentials("not json{");
  assert.equal(getLaminarConfig()?.userId, null, "unreadable credentials leave the trace unattributed");
  clear();
});

test("LMNR_USER_ID wins over the logged-in identity", () => {
  clear();
  process.env.LMNR_PROJECT_API_KEY = "sk-test";
  process.env.LMNR_USER_ID = "override";
  writeCredentials(JSON.stringify({ userEmail: "dev@example.com" }));
  assert.equal(getLaminarConfig()?.userId, "override");
  clear();
});

test("getLaminarConfig strips trailing slashes and reads userId", () => {
  clear();
  process.env.LMNR_PROJECT_API_KEY = "sk-test";
  process.env.LMNR_BASE_URL = "http://localhost:8000///";
  process.env.LMNR_USER_ID = "user-9";
  const cfg = getLaminarConfig();
  assert.equal(cfg?.baseUrl, "http://localhost:8000");
  assert.equal(cfg?.userId, "user-9");
  clear();
});

test("configFile honours XDG_CONFIG_HOME", () => {
  const dir = clear();
  assert.equal(configFile(), path.join(dir, "lmnr", "pi-extension.json"));
  clear();
});

test("getLaminarConfig falls back to the config file written by `plugin add pi`", () => {
  clear();
  writeConfigFile(JSON.stringify({ projectApiKey: "sk-file", baseUrl: "http://localhost:8000/" }));
  const cfg = getLaminarConfig();
  assert.deepEqual(cfg, { apiKey: "sk-file", baseUrl: "http://localhost:8000", userId: null });
  clear();
});

test("the environment overrides the config file", () => {
  clear();
  writeConfigFile(JSON.stringify({ projectApiKey: "sk-file", baseUrl: "http://localhost:8000" }));
  process.env.LMNR_PROJECT_API_KEY = "sk-env";
  process.env.LMNR_BASE_URL = "https://api.example.com";
  const cfg = getLaminarConfig();
  assert.equal(cfg?.apiKey, "sk-env");
  assert.equal(cfg?.baseUrl, "https://api.example.com");
  clear();
});

test("the config file supplies baseUrl when only the key is in the environment", () => {
  clear();
  writeConfigFile(JSON.stringify({ projectApiKey: "sk-file", baseUrl: "http://localhost:8000" }));
  process.env.LMNR_PROJECT_API_KEY = "sk-env";
  const cfg = getLaminarConfig();
  assert.equal(cfg?.apiKey, "sk-env");
  assert.equal(cfg?.baseUrl, "http://localhost:8000");
  clear();
});

test("a malformed config file is ignored (fail-open)", () => {
  clear();
  writeConfigFile("{ not json");
  assert.equal(getLaminarConfig(), null);
  clear();
});

test("a config file without a key is ignored", () => {
  clear();
  writeConfigFile(JSON.stringify({ baseUrl: "http://localhost:8000" }));
  assert.equal(getLaminarConfig(), null);
  clear();
});
