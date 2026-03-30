# claude-lsp-proxy

A multiplexing LSP proxy for Claude Code. Presents as a single LSP server
while internally managing multiple language servers per file type.

## Problem

Claude Code's LSP plugin system has limitations:

- **One server per file type** — can't run vtsls + ESLint for `.ts` files
- **No inter-server communication** — Volar 3 requires `tsserver/request` /
  `tsserver/response` forwarding between the Vue LS and a TypeScript LS
- **No lifecycle recovery** — a crashed LSP server requires restarting Claude
- **Cache `.lsp.json` args ignored** — Claude reads `command` from local plugin
  cache but fetches `args` from the remote marketplace, so local patches to
  launch arguments have no effect (tested on Claude Code 2.1.83)

## Project Structure

pnpm workspace monorepo with two packages:

- **`packages/proxy`** — the multiplexing proxy core. Dependencies:
  `vscode-jsonrpc`, `picomatch`, `valibot`. Exposes `generate-lsp-plugin` bin.
- **`packages/config-default`** — default server configs (vtsls + eslint for
  TS/JS). Depends on the proxy package and LSP server packages. Users can
  create their own config package with different servers.

The proxy accepts `--config-dir` to locate `proxy.config.json` and
`servers/*.json`. The `generate-lsp-plugin` bin reads configs from `cwd` and
writes `.lsp.json` / `.claude-plugin/plugin.json` there. Relative paths in
server configs (e.g., `./node_modules/...`) are resolved to absolute paths
at config load time so child servers inherit the workspace cwd.

## Design

A Node.js process that:

- Accepts stdio from Claude Code as a single LSP server
- Spawns and manages child LSP servers
- Routes requests by file type / language ID to the appropriate server(s)
- Merges diagnostics from multiple servers (union of push and pull models)
- Delivers per-server settings and responds to configuration pulls
- Auto-restarts crashed servers transparently
- Watches workspace files and resyncs document state on external changes
- Logs to `~/.claude/lsp-proxy/logs/<timestamp>.log` with runtime-configurable level

### Architecture

```
Claude Code (stdio)
    |
    v
claude-lsp-proxy (generic multiplexer)
    |--- vtsls
    |--- vue-language-server v3  (planned — requires bridging)
    |       |-- tsserver/request --> vtsls  (bridge)
    |       |<- tsserver/response <-- vtsls
    |--- eslint
    '--- css/html
```

### Server Configuration

Each server is defined in its own JSON file in the config package's `servers/`
directory (command, args, languages, transport, settings). The proxy loads
configs from `--config-dir` (or its own package root as fallback).

A separate `proxy.config.json` defines which servers to load:

```jsonc
{
  "servers": ["vtsls", "eslint"],
  // Optional — DEBUG, INFO (default), WARN, ERROR.
  // Change at runtime without restarting (file is watched).
  "logLevel": "INFO",
  // Glob patterns to exclude from workspace file watching.
  // Matches against paths relative to the workspace root.
  // Defaults shown below — override to customize.
  "watcherExclude": [
    "**/node_modules/**",
    "**/.git/**",
    "**/.hg/**",
    "**/.svn/**",
    "**/dist/**"
  ]
}
```

Future config fields (not yet implemented):

```jsonc
{
  "bridges": [{
    "from": "vue-volar",
    "notification": "tsserver/request",
    "to": "vtsls",
    "method": "typescript.tsserverRequest",
    "respond": "tsserver/response"
  }],
  "merge": {
    "diagnostics": "union",
    "completion": "interleave",
    "hover": "concatenate",
    "definition": "union",
    "references": "union",
    "codeAction": "union"
  }
}
```

### Key Decisions

- **Replaces individual plugins** — the proxy is the single LSP plugin
  registered with Claude Code; individual server plugins are not installed
- **JSON-RPC multiplexing** — each child server gets its own stdio pair;
  the proxy demuxes requests and muxes responses
- **File-type routing** — derived from each server's `extensionToLanguage`
  mapping; a file can fan out to multiple servers
- **Response merging** — diagnostics merged via union; other methods routed
  to primary server only (full merging planned for M4)
- **Pull diagnostics** — servers that advertise `diagnosticProvider` are
  proactively queried after document sync events and on
  `workspace/diagnostic/refresh`; results are stored and published via push
- **Settings delivery** — per-server `settings` in server configs are
  pushed via `workspace/didChangeConfiguration` after init and returned
  in response to `workspace/configuration` pulls, with `workspaceFolder`
  injected from the proxy's workspace root
- **Server-to-client request routing** — all server-initiated requests
  are tracked so client responses are delivered back to the originating
  server (not just register/unregister)
- **Notification bridging** — declarative config for forwarding custom
  notifications between servers (planned for M3)
- **Request ID namespacing** — proxy rewrites IDs to avoid collisions
  between servers, maps responses back to the original client ID
- **Lifecycle management** — exponential backoff restart with max retries;
  transparent to the client
- **Document state tracking** — proxy tracks `didOpen`/`didChange`/`didClose`
  and replays current state to servers that restart mid-session
- **File watching** — Claude Code doesn't send
  `workspace/didChangeWatchedFiles`, so the proxy watches tracked files
  with `fs.watch` (like VS Code's built-in file watcher). When an
  external tool (e.g., ESLint `--fix`, `git checkout`) modifies a file,
  the proxy reads from disk, compares with tracked content, and sends
  `didClose`/`didOpen` with fresh content to the relevant child servers.
- **Config/proxy separation** — the proxy package is server-agnostic; which
  servers to run is determined by the config package. Users create their own
  config package with different servers without forking the proxy.
- **Logging** — file-based (`~/.claude/lsp-proxy/logs/<timestamp>.log`), not
  stderr, so logs persist and don't interfere with stdio transport.
  Runtime level changes via `logLevel` in `proxy.config.json` (file
  watched). Server `window/logMessage` forwarded at appropriate severity.

### Volar 3 Forwarding (Example)

Volar 3 removed `hybridMode` — it always requires a companion TypeScript
server. The `bridges` config will handle this declaratively:

1. Volar sends `tsserver/request` notification: `[requestId, command, args]`
1. Proxy matches the bridge rule, forwards to vtsls
1. Proxy sends `tsserver/response` notification back: `[requestId, body]`

No proxy code changes needed — just config.

### Challenges

- **Response merging complexity** — deduplicating completions, formatting
  concatenated hovers, handling partial timeouts (one server fast, another
  slow). Start with diagnostics-only merging and expand incrementally.
- **Capability negotiation** — the proxy advertises the union of all child
  capabilities but must gracefully handle methods only some servers support
- **Stateful sync** — every child server needs document notifications in
  lockstep; a restarted server must receive the current document state

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
- Server-agnostic — works with any `.lsp.json`-compatible server

## Context from Prior Investigation

- Claude Code reads `command` from local `.lsp.json` cache but ignores `args`
  modifications — args come from the remote marketplace on startup
- The `.cmd` suffix patch for Windows npm shims IS read from local cache
- The `fix-lsp-support` tweakcc patch handles `.cmd` → executable resolution
- PSES (PowerShell) writes `PowerShellEditorServices.json` to cwd because the
  upstream plugin config lacks `-SessionDetailsPath` — unrelated to this project
  but relevant if PSES is included as a managed server

## References

- [Claude Code LSP plugin system](https://github.com/anthropics/claude-code)
- [Piebald-AI/claude-code-lsps](https://github.com/Piebald-AI/claude-code-lsps) — existing LSP plugins
- [vuejs/language-tools#5248](https://github.com/vuejs/language-tools/pull/5248) — hybridMode removal
- [vuejs/language-tools#5252](https://github.com/vuejs/language-tools/pull/5252) — notification-based forwarding
- [Claude Code issue #32912](https://github.com/anthropics/claude-code/issues/32912) — multiple LSP servers per language
- [Claude Code issue #16751](https://github.com/anthropics/claude-code/issues/16751) — Windows .cmd spawn ENOENT
