# Findings: config & secrets surface for a pi extension

How the Laminar extension obtains its config (API key, base URL, user id, debug/max-chars),
and the setup story for the hand-off spec. Sources: pi installed source
(`dist/core/extensions/loader.js`, `agent-session-services.js`, `settings-manager.js`) +
official [extensions.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md).
Config the emitter actually needs comes from the CC plugin's `config.ts`.

## The config mechanisms pi actually offers an extension

| Mechanism | What it is | Fit for our config |
|---|---|---|
| **`process.env`** | Node env, inherited from the launching shell; docs call it the primary secret path (`$ENV_VAR`/`${ENV_VAR}`/`!command` interpolation for provider keys) | ✅ **Secrets + all config.** Canonical. |
| **Flags** (`pi.registerFlag`/`pi.getFlag`) | Values come **from CLI args only** (`--name value`; booleans → `true`). Populated in `agent-session-services.js` from `extensionFlagValues`; unknown flags error. `default` in options. | ✅ non-secret toggles (`--lmnr-debug`); ❌ secrets (leak into shell history/process list, retype every launch) |
| **`settings.json`** | Fixed schema; `settings-manager` only exposes `extensions` (paths). **No generic per-extension key passthrough.** | ❌ no config surface here |
| **`appendEntry` + `sessionManager.getEntries()`** | Persists custom entries **into the session JSONL**, restored on `session_start` | ❌ for secrets (written into the transcript file = leak); unnecessary for non-secrets |
| `.env` file | pi has **no dotenv/auto-load** (confirmed: no `dotenv`/`loadEnvFile` in dist) | ❌ not automatic; extension would have to self-load |

**There is no CC-`plugin.json`-`userConfig` analog.** CC sourced config via
`CLAUDE_PLUGIN_OPTION_<NAME>` with a plain-env fallback (`opt()` in its `config.ts`); pi has
**no manifest-declared option layer at all**, only `process.env`.

## Decision: env-primary, no manifest, flags for toggles only

**Secrets & config live in `process.env`**, reusing the *plain* names CC already honored as
its primary fallback (also matching Laminar's own SDK convention) — just without the
`CLAUDE_PLUGIN_OPTION_`/`CC_` layers:

| Env var | Meaning | Default / behavior |
|---|---|---|
| `LMNR_PROJECT_API_KEY` | Laminar project key (**secret, required**) | **absent → fail-open: config is null, no export** (mirrors CC `getLaminarConfig()→null`) |
| `LMNR_BASE_URL` | Laminar OTLP endpoint base | `https://api.lmnr.ai` (trailing `/` stripped) |
| `LMNR_USER_ID` | optional `lmnr.association.properties.user_id` | null |
| `LMNR_DEBUG` | verbose logging | `false` |
| `LMNR_MAX_CHARS` | input/output truncation cap | `20000` (feeds ticket 5) |

`EXPORT_TIMEOUT_S` stays a **constant (5s)**, as in CC (optionally env-overridable later;
not for v1). This is ticket 6's to confirm.

**Precedence** per knob: **CLI flag (if registered & provided) > `process.env` > built-in
default.** The **API key is env-only** — never a flag (secrets must not hit CLI history).
Non-secret toggles like debug MAY also be exposed as `pi.registerFlag("lmnr-debug", …)` for
ergonomics; flags win over env when present.

## Setup story (for the hand-off spec)

Export the key in the **shell profile** so it's inherited by every interactive `pi` session:
```sh
# ~/.zshrc or ~/.bashrc
export LMNR_PROJECT_API_KEY="..."
# optional:
export LMNR_BASE_URL="https://api.lmnr.ai"
export LMNR_USER_ID="..."
```
The extension reads `process.env` at load / per-run. **No config file to edit, no `/setup`
command required for v1.**

### This closes the CC "live-config gap"
CC's installed plugin had *no key* in a live session because it leaned on a plugin-manifest
option that wasn't populated at runtime (only the env fallback saved it). pi has no manifest
option to fall short — by making **env the primary and only secret path**, there's no gap to
fall into. When the key is missing we **fail open silently** (log at debug, emit nothing),
never breaking pi.

## Notes for the spec
- Use pi's `CONFIG_DIR_NAME` (not a hardcoded `.pi`) if the extension ever builds
  project-local config paths — respects rebranded distributions (per docs).
- An optional self-loaded `.env` (extension reads `${extensionDir}/.env`) is a possible
  later ergonomic add; **out for v1** to stay lean and dependency-free.
