import assert from "node:assert/strict";
import { test } from "node:test";
import { getLaminarConfig, getRolloutSessionId } from "../src/config.js";

const KEYS = ["LMNR_PROJECT_API_KEY", "LMNR_BASE_URL", "LMNR_USER_ID", "LMNR_DEBUG", "LMNR_DEBUG_SESSION_ID"];
function clear(): void {
  for (const k of KEYS) {
    delete process.env[k];
  }
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

test("getRolloutSessionId is null when LMNR_DEBUG is off", () => {
  clear();
  assert.equal(getRolloutSessionId("/tmp"), null);
});

test("getRolloutSessionId prefers LMNR_DEBUG_SESSION_ID when debug is on", () => {
  clear();
  process.env.LMNR_DEBUG = "1"; // truthy set includes 1/true/yes/on
  process.env.LMNR_DEBUG_SESSION_ID = "rollout-abc";
  assert.equal(getRolloutSessionId("/tmp"), "rollout-abc");
  clear();
});
