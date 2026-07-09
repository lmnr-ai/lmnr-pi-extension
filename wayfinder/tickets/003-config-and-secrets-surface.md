---
id: 3
title: "Config & secrets surface for a pi extension"
type: research
status: closed
assignee: kyanghasglasses@gmail.com
blockedBy: [1]
---

## Question

How does the extension obtain its config — Laminar project API key, base URL, optional
user id, debug/max-chars knobs — and is there a per-extension config mechanism, or is it
env-only?

Investigate/decide:
- Does pi expose a `userConfig`-style manifest for extensions (the way Claude Code's
  `plugin.json` declared `sensitive` fields), or do extensions read `process.env` only?
- If env-only, where does the key live so it's present in a normal interactive pi session
  (shell profile? `~/.pi/agent/settings.json`? a persisted `pi.appendEntry` config entry
  set via a `/command`)? Note the Claude Code plugin's live-config gap (the installed
  plugin had no key until configured) — avoid repeating it.
- Decide the canonical config precedence and the setup story the hand-off spec will document.

## Resolution

Verified against pi's installed source + docs. Full write-up:
[findings/003](../findings/003-config-secrets.md).

**No `userConfig`-style manifest exists.** pi offers no CC-`plugin.json` analog:
`settings.json` exposes only the `extensions` paths array (no per-extension key passthrough),
there's no `.env` auto-load, and extension **flags come from CLI args only**. So config is
**`process.env`** (pi's documented primary secret path), with flags reserved for non-secret
toggles and `appendEntry` rejected for secrets (it persists into the session JSONL = leak).

**Decision — env-primary.** Reuse the plain names CC already honored (also Laminar's SDK
convention), dropping the `CC_`/`CLAUDE_PLUGIN_OPTION_` layers:
`LMNR_PROJECT_API_KEY` (secret, **required — absent ⇒ fail-open, no export**),
`LMNR_BASE_URL` (default `https://api.lmnr.ai`), `LMNR_USER_ID` (optional),
`LMNR_DEBUG`, `LMNR_MAX_CHARS` (default 20000, feeds ticket 5). `EXPORT_TIMEOUT_S` stays a
5s constant (ticket 6 confirms). **Precedence:** CLI flag (if registered) > `process.env` >
default; **API key is env-only** (never a flag — no secrets in shell history).

**Setup story:** `export LMNR_PROJECT_API_KEY=…` in `~/.zshrc`/`~/.bashrc`, inherited by
every interactive `pi` session; no config file, no `/setup` command for v1. This **closes
the CC "live-config gap"**: CC leaned on a manifest option unpopulated at runtime; making env
the sole secret path means there's no gap to fall into — and a missing key fails open
silently.
