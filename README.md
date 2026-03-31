# lsp-proxy

A multiplexing LSP proxy. Presents as a single LSP server while internally
managing multiple language servers per file type, with transparent crash
recovery and document state replay. Works with any LSP client — compensates
automatically for clients with incomplete LSP implementations.

## Motivation

LSP clients that only support a single server per file type can't combine
complementary servers (e.g., vtsls for TypeScript intelligence + ESLint for
linting). The proxy solves this by multiplexing multiple servers behind a
single LSP interface, with crash recovery and capability compensation for
clients with incomplete LSP implementations.

### Claude Code

This project was originally built for Claude Code, which has several
limitations the proxy addresses:

- [One server per file type](https://github.com/anthropics/claude-code/issues/27692)
- No lifecycle recovery for crashed servers
- No `workspace/didChangeWatchedFiles` support
- No pull diagnostic (`textDocument/diagnostic`) support
- [Windows `.cmd` spawn failures](https://github.com/anthropics/claude-code/issues/16751)

## How It Works

The proxy presents as a single LSP server over stdio. It spawns child LSP
servers, routes requests by file type, merges diagnostics, and tracks document
state. If a child server crashes, the proxy restarts it with exponential
backoff and replays open documents.

During `initialize`, the proxy inspects client capabilities and compensates
for missing features (e.g., local file watching when the client lacks
`didChangeWatchedFiles`, proactive pull diagnostics when the client lacks
`textDocument/diagnostic`). File URIs are normalized to standard `file:///`
format to ensure consistent behavior across servers that emit non-standard
URIs.

```
Client (stdio) <--> lsp-proxy <--> vtsls
                               \-> eslint
```

## Packages

| Package | Description |
|---------|-------------|
| [`packages/proxy`](packages/proxy) | The multiplexing proxy core |
| [`packages/claude-code`](packages/claude-code) | Claude Code editor integration |
| [`packages/config-default`](packages/config-default) | Example server configs (vtsls + eslint for TS/JS) |
| [`packages/vscode-eslint-extracted`](packages/vscode-eslint-extracted) | ESLint language server extracted from the VS Code extension |

## Quick Start

```sh
pnpm install
pnpm build
```

## Usage with Claude Code

Generate the plugin files from your config package:

```sh
pnpm -C packages/config-default generate-plugin
```

This creates `.lsp.json` and `.claude-plugin/plugin.json` in
`packages/config-default/`. The generated files contain absolute paths —
re-run this command if you move the directory.

### Dev/testing (current session only)

```sh
claude --plugin-dir /path/to/packages/config-default
```

### Persistent (local marketplace)

In Claude Code:

```
/plugin marketplace add /absolute/path/to/packages/config-default
/plugin install lsp-proxy@lsp-proxy
```

### Conflicting plugins

Disable individual LSP plugins that handle the same file types:

```
/plugin disable vtsls@claude-code-lsps
```

## Custom Server Configuration

To use different LSP servers, create your own config package:

```sh
mkdir my-lsp-config && cd my-lsp-config
pnpm init
pnpm add lsp-proxy lsp-proxy-claude-code
pnpm add vscode-langservers-extracted  # or whatever servers you need
```

Create `.lsp-proxy.json`:

```json
{
  "servers": ["css"]
}
```

Create `servers/css.json`:

```json
{
  "command": "node",
  "args": ["./node_modules/vscode-langservers-extracted/bin/vscode-css-language-server", "--stdio"],
  "languages": {
    "css": [".css"],
    "scss": [".scss"],
    "less": [".less"]
  },
  "transport": "stdio"
}
```

Servers that need configuration can include a `settings` field. The proxy
delivers these via `workspace/didChangeConfiguration` after init and responds
to `workspace/configuration` pulls:

```json
{
  "command": "node",
  "args": ["./node_modules/vscode-eslint-extracted/dist/eslintServer.js", "--stdio"],
  "languages": { "typescript": [".ts"] },
  "transport": "stdio",
  "settings": {
    "validate": "on",
    "run": "onType"
  }
}
```

Generate and register:

```sh
pnpm exec generate-claude-plugin
claude --plugin-dir /path/to/my-lsp-config
```

## Logging

The proxy logs to `<logDir>/<timestamp>-<pid>.log`. The log directory is
resolved via `--log-dir` CLI flag > `logDir` in `.lsp-proxy.json` >
platform default (`$XDG_DATA_HOME/lsp-proxy/logs` on Linux/macOS,
`%LOCALAPPDATA%\lsp-proxy\logs` on Windows). The default level is INFO.

To change the level at runtime (no restart needed), add `logLevel` to your
`.lsp-proxy.json`:

```json
{
  "servers": ["vtsls", "eslint"],
  "logLevel": "DEBUG"
}
```

Valid levels: `DEBUG`, `INFO`, `WARN`, `ERROR`. Remove the field to reset to
INFO.

Server `window/logMessage` notifications are forwarded at the appropriate
severity (Error → error, Warning → warn, Info/Log → debug).

## Testing

```sh
pnpm test        # vitest only
pnpm build       # type-check + lint + test + generate plugin
```

## Roadmap

See [AGENTS.md](./AGENTS.md) for the full design and milestone plan.
