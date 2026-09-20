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
  injected from the proxy's workspace root. Strings inside them that
  begin with `./` resolve against the config directory, as `command` and
  `args` do: the proxy cannot know which of a server's settings name
  files, so the prefix decides rather than the key.
- **Server-to-client request routing** — all server-initiated requests
  are tracked so client responses are delivered back to the originating
  server (not just register/unregister)
- **Request ID namespacing** — proxy rewrites IDs to avoid collisions
  between servers, maps responses back to the original client ID.
  Requests the proxy raises itself carry a `__proxy:` prefix and are
  settled by the request channel, never reported to the client.
- **Notification bridging** — a `bridges` entry answers one server's
  protocol notifications from another instead of passing them to a client
  that cannot serve them. See Volar 3 Forwarding below.
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

## Volar 3 Forwarding

Volar 3 removed `hybridMode`: the Vue language server no longer reaches a
TypeScript server itself, and asks its editor to instead. The proxy manages
such a server already, so it answers in the editor's place. A `bridges` entry
names the two ends:

```jsonc
{
  "bridges": [{ "protocol": "tsserver", "from": "vue", "to": "vtsls" }],
}
```

1. Vue sends the `tsserver/request` notification `[id, command, args]`, where
   `command` is one of the `_vue:` commands that `@vue/typescript-plugin`
   installs into tsserver
1. The proxy asks vtsls to run it, as `workspace/executeCommand` of
   `typescript.tsserverRequest` with `[command, args, config]` — the third
   argument carrying `isAsync` and `lowPriority`, so the request neither
   blocks nor outranks the user's own edits
1. The proxy answers Vue with `tsserver/response` `[id, body]`, unwrapping
   `body` from the command result

The wire details above sit in `bridge.ts` rather than in config, because they
belong to the protocol: Vue picks the correlation id, and the whole exchange is
meaningless to a client that never asked for it, so the notification stops at
the proxy.

Two consequences worth keeping in view:

- Vue holds a handler open for every id it sends, so a failed command still
  answers, with a null body. Dropping the response strands the request.
- tsserver only recognises the `_vue:` commands when `@vue/typescript-plugin`
  is loaded into it, via vtsls's `vtsls.tsserver.globalPlugins` setting.

Still to come: the `@vue/language-server` registry entry and `.vue` routing,
and response merging for M4:

```jsonc
{
  "merge": {
    "diagnostics": "union",
    "completion": "interleave",
    "hover": "concatenate",
    "definition": "union",
    "references": "union",
    "codeAction": "union",
  },
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
