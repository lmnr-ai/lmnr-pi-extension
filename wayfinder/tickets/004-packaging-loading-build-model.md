---
id: 4
title: "Extension packaging, loading & build model"
type: research
status: closed
assignee: kyanghasglasses@gmail.com
blockedBy: [1]
---

## Question

How is a pi extension physically shipped, loaded, and run — and does it need a build step
at all?

Investigate/decide:
- Does pi execute extension `.ts` **directly** (bun/on-the-fly transpile), so there is NO
  build artifact to commit (unlike the Claude Code plugin's committed `dist/hook.cjs`)? Or
  does it expect compiled `.js`?
- Can an extension import **npm dependencies** (specifically the OpenTelemetry SDK +
  OTLP/HTTP exporter), and if so how are they resolved — `node_modules` next to the
  extension, a bundled single file, or pi-provided runtime? This decides whether esbuild is
  needed.
- Install location & discovery: single file vs directory in `~/.pi/agent/extensions/`
  (global) vs `.pi/extensions/` (project-local); hot-reload implications.
- The distribution story for the hand-off spec (how a user installs it, versioning).

This determines whether the emitter can be imported as-is from the CC plugin or must be
bundled — feeds the code-reuse boundary ticket.

## Resolution

Verified against pi's own installed source (`@earendil-works/pi-coding-agent@0.80.3` →
`dist/core/extensions/loader.js` + `config.js`) and the official extensions docs. Full
write-up: [findings/002](../findings/002-packaging-loading.md).

**No build step.** pi loads extensions with **jiti** (`jiti@2.7.0`, a direct dep):
`createJiti(...).import(path, {default:true})`. `.ts` runs directly, transpiled at runtime;
`.js` also accepted. **Nothing to compile or commit** — the sharp break from the CC plugin's
committed `dist/hook.cjs`. The extension is a **default-exported factory**:
`export default (pi) => { pi.on(…) }`, where `pi` is pi's `ExtensionAPI`.

**npm deps (OTel) resolve from a local `node_modules` — no bundling needed.** In the Node
distribution (how pi is installed here — `node dist/cli.js`, `isBunBinary=false`), jiti keeps
native filesystem resolution on and only aliases pi's *own* packages, so `@opentelemetry/*`
imports resolve from the extension package's `node_modules` (docs: *"Add a `package.json`
next to your extension … run `npm install`, and imports from `node_modules/` are resolved
automatically."*). ⇒ **the CC emitter's OTel imports port unchanged** (feeds ticket 7).

**Packaging decision — directory package:** ship at `~/.pi/agent/extensions/<name>/`
(global) or `.pi/extensions/<name>/` (project-local, loads after project trust), containing
`package.json` (`"type":"module"`, OTel SDK + OTLP/HTTP exporter in **`dependencies`** —
prod installs omit devDeps), an `index.ts` factory (no dist), and `node_modules`. Discovery
also supports a single `.ts` file and a `pi.extensions` manifest field, but the directory
form is required to carry the OTel deps. **Distribution:** as a pi package via
**`pi install`** (npm or git), semver in `package.json`. **Hot reload** via `/reload` in
auto-discovered locations.

**Known limitation (scoped, not built for v1):** under the *compiled-Bun-binary* pi
distribution, `loader.js` disables filesystem resolution (`tryNative:false`,
`virtualModules` only) — arbitrary npm deps like OTel would NOT resolve there. Hedge if that
runtime must ever be supported: bundle the extension + OTel into one dependency-free file
with esbuild. Our target (Node / `pi install`) is unaffected.
