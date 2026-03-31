# Claude Code Integration Internals

Context for the Claude Code editor integration layer and upstream LSP
behavior. For user-facing docs see [README.md](./README.md).

## Prior Investigation

- Claude Code reads `command` from local `.lsp.json` cache but ignores
  `args` modifications — args come from the remote marketplace on startup
- The `.cmd` suffix patch for Windows npm shims IS read from local cache
- PSES (PowerShell) writes `PowerShellEditorServices.json` to cwd because
  the upstream plugin config lacks `-SessionDetailsPath` — unrelated to
  this project but relevant if PSES is included as a managed server

## Claude Code LSP internals (reviewed 2026-03-31, v2.1.88)

The native LSP implementation lives in `src/services/lsp/` (~1,700 lines)
and `src/tools/LSPTool/` (~860 lines). Key findings:

- **One server per file type** — `LSPServerManager.getServerForFile`
  returns `extensionMap.get(ext)[0]` (first match only). No fan-out,
  no diagnostic merging across servers.
- **Crash recovery is demand-driven** — `LSPServerInstance` passes an
  `onCrash` callback to `LSPClient` that flips `state = 'error'`. Next
  `ensureServerStarted()` retries with a cap (`maxRestarts`, default 3).
  No automatic restart loop, no document state replay after recovery.
- **No `workspace/configuration` delivery** — `LSPServerManager`
  registers a handler that returns `null` for every config item.
  `LSPServerInstance` declares `configuration: false` in capabilities.
  The `settings` field in `.lsp.json` is parsed by the schema but never
  read or delivered to servers. Piebald-AI plugins define `settings`
  (non-empty for eslint) but the values are inert.
- **`initializationOptions` IS forwarded** — servers that accept one-shot
  init config (e.g., vue-language-server) receive it from the plugin config.
- **No document version tracking** — `changeFile` always sends
  `version: 1`, violating the LSP spec's monotonic version requirement.
- **No `didClose` integration** — the method exists but is never called;
  files opened on servers stay open forever.
- **No file watching** — zero `workspace/didChangeWatchedFiles` support.
- **No pull diagnostics** — no `textDocument/diagnostic` support.
- **Diagnostics as async attachments** — `publishDiagnostics` notifications
  go through a global `LSPDiagnosticRegistry` (Map + LRU dedup) and are
  injected into the next LLM query turn as conversation attachments.
- **Lazy require** — `LSPServerInstance` uses `require('./LSPClient.js')`
  to defer loading `vscode-jsonrpc` (~129KB) until a server is instantiated.
- **Transient error retry** — `sendRequest` retries `-32801`
  (ContentModified) with exponential backoff (500ms/1s/2s, 3 attempts).
- **Global singleton** — `manager.ts` holds a module-level singleton with
  a generation counter for async init race protection.

## tweakcc `fix-lsp-support` patch

The [tweakcc](https://github.com/Piebald-AI/tweakcc) `fix-lsp-support`
patch (always-applied category) modifies Claude Code's minified bundle to:

1. **Remove validation guards** — strips the `restartOnCrash`,
   `startupTimeout`, and `shutdownTimeout` "not yet implemented" throws
   from `LSPServerInstance`, unblocking those config fields for plugins.
1. **Inject `didOpen` before `sendRequest`** — patches the `sendRequest`
   code path to read the file from disk and send `textDocument/didOpen`
   (with a hardcoded extension → languageId map) before each request.
   This compensates for Claude Code's LSPTool not always opening files
   before querying servers.

The patch does **not** add `workspace/configuration` delivery, file
watching, version tracking, or any other missing LSP feature.
