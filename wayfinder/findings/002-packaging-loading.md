# Findings: pi extension packaging, loading & build model

How a pi extension is physically shipped, loaded, and run — and what that means for
importing the OpenTelemetry SDK. Sources: pi's own installed source
`@earendil-works/pi-coding-agent@0.80.3` → `dist/core/extensions/loader.js` +
`dist/config.js` (primary, authoritative), and the official
[extensions.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md).

## The local pi install (ground truth)

- Package: **`@earendil-works/pi-coding-agent@0.80.3`** (pnpm global), run as
  **`node dist/cli.js`** under **Node v22** — i.e. the *Node distribution*, not the
  compiled-Bun-binary distribution. `isBunBinary` is computed from `import.meta.url`
  containing bun markers (`$bunfs`/`~BUN`); false here.
- Direct dependency **`jiti@2.7.0`** is the load-bearing fact.
- No `~/.pi/agent/extensions/` dir exists yet (nothing installed locally to crib from).

## 1. No build step — `.ts` runs directly via jiti

`loader.js` loads each extension with `createJiti(...).import(extensionPath, {default:true})`.
Docs: *"Extensions are loaded via jiti, so TypeScript works without compilation."*
`isExtensionFile` accepts **`.ts` or `.js`**. **There is no build artifact to commit** —
the sharp divergence from the Claude Code plugin's committed `dist/hook.cjs`. We ship
source `.ts`; jiti transpiles at runtime.

The extension is a **default-exported factory function**: the loader does
`const factory = await jiti.import(path, {default:true})`, checks `typeof factory ==="function"`,
then `await factory(api)`. So the shape is `export default function (pi) { pi.on(…) }` —
`pi` is pi's `ExtensionAPI` (the loader's `createExtensionAPI`), carrying `on`,
`registerTool/Command/…`, `appendEntry`, `exec`, `events`, etc.

## 2. npm deps (OTel) — resolved from a local `node_modules`

Docs: *"npm dependencies work too. Add a `package.json` next to your extension (or in a
parent directory), run `npm install`, and imports from `node_modules/` are resolved
automatically."* In the **Node distribution** (our case) jiti is created with
`alias: getAliases()` and native resolution left ON, so a bare import like
`@opentelemetry/api` resolves through the normal Node `node_modules` walk from the
extension's directory. `getAliases()` only special-cases pi's *own* packages
(`@earendil-works/pi-*`, typebox) — everything else (OTel) comes from the extension's
`node_modules`.

⇒ **The whole OTel emitter imports work unchanged** (`@opentelemetry/api`, `/core`,
`/resources`, `/sdk-trace-base`, `/exporter-trace-otlp-http`) as long as they're installed
in the extension package's `node_modules`. **No esbuild/bundling required** for the
standard path. This directly feeds the code-reuse boundary ticket: `tracer.ts` ports as-is.

### ⚠ Bun-single-binary caveat (portability limit)
If pi is instead run as the *compiled Bun binary*, `loader.js` switches jiti to
`{ virtualModules: VIRTUAL_MODULES, tryNative: false }` — filesystem resolution is
**disabled**, and only pi's bundled packages (pi-agent-core/tui/ai/coding-agent + typebox)
are importable. **Arbitrary npm deps like OTel would NOT resolve under that binary.**
Our target (Node distribution / `pi install`) is fine. The hedge if binary support is ever
needed: **bundle** the extension + OTel into one dependency-free file with esbuild (jiti
then just runs it, no resolution needed). Recommended to note as a known limitation, not to
build for v1.

## 3. Install locations, discovery & structure

`discoverAndLoadExtensions` scans, in precedence order:
1. **Project-local**: `cwd/.pi/extensions/` (`CONFIG_DIR_NAME=".pi"`) — loads only after the
   project is *trusted*.
2. **Global**: `~/.pi/agent/extensions/` (`getAgentDir()`).
3. Explicit paths from `settings.json` `"extensions": [...]`, or `pi -e ./path.ts` (quick tests).

`discoverExtensionsInDir` (no recursion beyond one level) accepts three structures:
- **Single file**: `extensions/*.ts` (or `.js`).
- **Directory with `index.ts`/`index.js`**: multi-file extension.
- **Package with `package.json`**: if it has a `pi.extensions: [...]` manifest field, load
  exactly those entries; else fall back to `index.ts`/`index.js`. This is the form that
  carries `dependencies` + `node_modules`.

## 4. Hot reload

Extensions in the auto-discovered locations hot-reload with **`/reload`**; `loader.js` has a
cwd-keyed cache that clears on generation bump. `pi -e` is for one-off tests only.

## 5. Distribution to end users

Docs: distributed as **"pi packages" installed with `pi install`** (from npm or git).
*"runtime deps must be in `dependencies`"* — installs are production (`npm install --omit=dev`),
so `devDependencies` are absent at runtime. ⇒ OTel packages go in **`dependencies`**.
Versioning via the package's semver. (Exact publish recipe lives in pi's `packages.md`;
enough is known for the v1 spec.)

## Bottom line for the spec

Ship the extension as a **directory package** at `~/.pi/agent/extensions/<name>/` (global)
or `.pi/extensions/<name>/` (project-local), containing:
- `package.json` — `"type":"module"`, OTel SDK + OTLP/HTTP exporter in `dependencies`,
  optional `pi.extensions` manifest (else rely on `index.ts`).
- `index.ts` — the default-export factory (`export default (pi) => {…}`); imports the reused
  emitter and registers handlers. **No build step, no committed dist.**
- `node_modules/` from `npm install` (or resolved by `pi install` at install time).

Distribute as a pi package (`pi install` npm/git). Bundling is an optional hedge only if the
compiled-Bun-binary pi runtime must be supported.
