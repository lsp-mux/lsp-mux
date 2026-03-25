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

## Design

A Node.js process that:

- Accepts stdio from Claude Code as a single LSP server
- Spawns and manages child LSP servers
- Routes requests by file type / language ID to the appropriate server(s)
- Merges responses from multiple servers (diagnostics, completions, hovers)
- Bridges inter-server protocols (Volar 3's tsserver request forwarding)
- Auto-restarts crashed servers transparently

### Architecture

```
Claude Code (stdio)
    |
    v
claude-lsp-proxy (generic multiplexer)
    |--- vtsls
    |--- vue-language-server v3
    |       |-- tsserver/request --> vtsls  (bridge)
    |       |<- tsserver/response <-- vtsls
    |--- eslint
    '--- css/html
```

### Server Configuration

Each server is defined in its own JSON file using the same format as
claude-code-lsps `.lsp.json` (command, args, languages, transport, settings).
The proxy ships with default configs; users can copy/modify from
claude-code-lsps as a starting point.

Server configs are loaded from layered sources (later overrides earlier):
bundled defaults → user config → project config. Exact paths TBD.

A separate proxy config defines the multiplexing layer:

```jsonc
{
  "servers": ["vtsls", "vue-volar", "vscode-langservers"],
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
- **Response merging** — configurable per-method strategy for combining
  results from multiple servers
- **Notification bridging** — declarative config for forwarding custom
  notifications between servers (e.g., Volar 3's tsserver protocol)
- **Request ID namespacing** — proxy rewrites IDs to avoid collisions
  between servers, maps responses back to the original client ID
- **Lifecycle management** — exponential backoff restart with max retries;
  transparent to the client
- **Document state tracking** — proxy tracks `didOpen`/`didChange`/`didClose`
  and replays current state to servers that restart mid-session

### Volar 3 Forwarding (Example)

Volar 3 removed `hybridMode` — it always requires a companion TypeScript
server. The `bridges` config handles this declaratively:

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

### M1: Single-server passthrough

Wire up the proxy to manage a single child server (vtsls) with lifecycle
restart. Validates the JSON-RPC multiplexing, initialize/shutdown
coordination, and document state tracking. No merging yet.

### M2: Multi-server diagnostics

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
