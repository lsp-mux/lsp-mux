# Proxy Internals

Implementation details for the multiplexing proxy core. For user-facing
docs see [README.md](./README.md).

## Key Decisions

- **JSON-RPC multiplexing** — each child server gets its own stdio pair;
  the proxy demuxes requests and muxes responses
- **File-type routing** — derived from each server's `languages`
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
- **Request ID namespacing** — proxy rewrites IDs to avoid collisions
  between servers, maps responses back to the original client ID
- **Lifecycle management** — exponential backoff restart with max retries;
  transparent to the client
- **Document state tracking** — proxy tracks `didOpen`/`didChange`/`didClose`
  and replays current state to servers that restart mid-session
- **URI normalization** — file URIs from clients and servers are
  normalized to standard `file:///` format on ingest. Some LSP
  implementations (e.g., vtsls on Windows) emit non-standard URIs
  with backslashes or missing authority slashes, which breaks
  cross-server features like diagnostics merging and configuration
  resolution. Round-trip through `fileURLToPath`/`pathToFileURL`
  ensures consistent keying across the proxy.
- **Client capability compensation** — during `initialize`, the proxy
  inspects the client's `ClientCapabilities` and compensates for missing
  features: local file watching when `didChangeWatchedFiles` dynamic
  registration is absent, and proactive pull diagnostics when the client
  lacks `textDocument/diagnostic` support. Clients that support these
  natively receive forwarded registrations instead.
- **File watching** (compensation) — when the client lacks native file
  watching support, the proxy watches tracked files with `fs.watch`
  (like VS Code's built-in file watcher). When an external tool (e.g.,
  ESLint `--fix`, `git checkout`) modifies a file, the proxy reads from
  disk, compares with tracked content, and sends `didClose`/`didOpen`
  with fresh content to the relevant child servers.
- **Logging** — file-based, not stderr, so logs persist and don't
  interfere with stdio transport. Log directory resolved via
  `--log-dir` CLI flag > `logDir` in `.lsp-proxy.json` >
  platform default (`$XDG_DATA_HOME/lsp-proxy/logs` on Linux/macOS,
  `%LOCALAPPDATA%\lsp-proxy\logs` on Windows). Runtime level changes
  via `logLevel` in `.lsp-proxy.json` (file watched). Server
  `window/logMessage` forwarded at appropriate severity.

## Volar 3 Forwarding (Planned)

Volar 3 removed `hybridMode` — it always requires a companion TypeScript
server. The `bridges` config will handle this declaratively:

1. Volar sends `tsserver/request` notification: `[requestId, command, args]`
1. Proxy matches the bridge rule, forwards to vtsls
1. Proxy sends `tsserver/response` notification back: `[requestId, body]`

No proxy code changes needed — just config.

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

## Challenges

- **Response merging complexity** — deduplicating completions, formatting
  concatenated hovers, handling partial timeouts (one server fast, another
  slow). Start with diagnostics-only merging and expand incrementally.
- **Capability negotiation** — the proxy advertises the union of all child
  capabilities but must gracefully handle methods only some servers support
- **Stateful sync** — every child server needs document notifications in
  lockstep; a restarted server must receive the current document state
