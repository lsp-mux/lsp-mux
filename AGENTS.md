# lsp-proxy

A multiplexing LSP proxy. Presents as a single LSP server while
internally managing multiple language servers per file type.

User-facing docs (prerequisites, quickstart, usage) live in
[README.md](./README.md) at the repo root. This file (AGENTS.md)
is design context for agents. Implementation details live in
package-level AGENTS.md files.

## Problem

Claude Code's LSP plugin system has limitations:

- **One server per file type** — can't run vtsls + ESLint for `.ts` files
- **No inter-server communication** — Volar 3 requires `tsserver/request` /
  `tsserver/response` forwarding between the Vue LS and a TypeScript LS
- **No transparent crash recovery** — Claude Code restarts crashed servers on
  next use but without document state replay; open files must be re-synced
  from disk and any in-flight requests are lost
- **Cache `.lsp.json` args ignored** — Claude reads `command` from local plugin
  cache but fetches `args` from the remote marketplace, so local patches to
  launch arguments have no effect (tested on Claude Code 2.1.83)

## Project Structure

pnpm workspace monorepo:

- **`packages/proxy`** — the multiplexing proxy core. Dependencies:
  `vscode-jsonrpc`, `picomatch`, `valibot`.
- **`packages/registry`** — server config registry. Pre-defined configs
  for common LSP servers (vtsls, eslint) embedded via build-time codegen
  from `entries/*.json`. The proxy resolves server names from the registry,
  deep-merges user overrides, and validates npm deps.
- **`packages/claude-code`** — Claude Code editor integration. Provides
  `generate-claude-plugin` bin that produces `.lsp.json` and
  `.claude-plugin/` artifacts from a config directory.
- **`packages/config-default`** — default server configs (vtsls + eslint
  for TS/JS). Installable standalone from npm — `postinstall` generates
  plugin files automatically. Users can create their own config package
  with different servers.
- **`packages/vscode-eslint-extracted`** — ESLint language server extracted
  from the VS Code ESLint extension VSIX. Downloads the pre-built server on
  `postinstall`. Provides `vscode-eslint-extract` bin for manual
  re-download. Needed because `vscode-langservers-extracted` doesn't
  support ESLint 10 flat config.

## Architecture

```
Claude Code (stdio)
    |
    v
lsp-proxy (generic multiplexer)
    |--- vtsls
    |--- vue-language-server v3  (planned — requires bridging)
    |       |-- tsserver/request --> vtsls  (bridge)
    |       |<- tsserver/response <-- vtsls
    |--- eslint
    '--- css/html
```

## Milestones

### M1: Single-server passthrough (done)

Wire up the proxy to manage a single child server (vtsls) with lifecycle
restart. Validates the JSON-RPC multiplexing, initialize/shutdown
coordination, and document state tracking. No merging yet.

### M2: Multi-server diagnostics (done)

Add a second server (eslint) for `.ts`/`.js` files. Merge diagnostics
from both via union. Fan out `didOpen`/`didChange`/`didClose` to both.
Route single-response methods (hover, definition) to primary server only.

### M3: Notification bridging + Volar 3

Implement the bridge config. Add vue-language-server v3 and wire
`tsserver/request` → vtsls. This replaces the Volar 2 plugin.

### M4: Full response merging

Extend merging to completions, hover, code actions. Handle deduplication,
timeout/fallback, and capability-aware routing.

## Tech Stack

- Node.js (same runtime as the servers it manages)
- `vscode-jsonrpc` for LSP message parsing
- `valibot` for config schema validation
- `picomatch` for glob pattern matching (file watcher exclusions)
- Distributed as a Claude Code LSP plugin (`.lsp.json` + `plugin.json`)
- All packages publish from `dist/source/` via `publishConfig.directory`
- `scripts/prepare-publish.ts` copies manifests and merges
  `publishConfig.scripts` (not natively supported by pnpm)
- Server-agnostic — works with any `.lsp.json`-compatible server

## References

- [Claude Code LSP plugin system](https://github.com/anthropics/claude-code)
- [Piebald-AI/claude-code-lsps](https://github.com/Piebald-AI/claude-code-lsps) — existing LSP plugins
- [vuejs/language-tools#5248](https://github.com/vuejs/language-tools/pull/5248) — hybridMode removal
- [vuejs/language-tools#5252](https://github.com/vuejs/language-tools/pull/5252) — notification-based forwarding
- [Claude Code issue #32912](https://github.com/anthropics/claude-code/issues/32912) — multiple LSP servers per language
- [Claude Code issue #16751](https://github.com/anthropics/claude-code/issues/16751) — Windows .cmd spawn ENOENT
