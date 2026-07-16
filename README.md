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
- No transparent crash recovery — servers restart on next use but without
  document state replay, so open files must be re-synced from disk
- No `workspace/configuration` support — returns `null` for all config
  items, so servers like vtsls receive no settings
- No document version tracking — always sends `version: 1` for
  `didChange`, violating the LSP spec's monotonic version requirement
- No `workspace/didChangeWatchedFiles` support
- No pull diagnostic (`textDocument/diagnostic`) support
- No `didClose` integration — files opened on servers are never closed
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

| Package                                              | Description                                       |
| ---------------------------------------------------- | ------------------------------------------------- |
| [`packages/proxy`](packages/proxy)                   | The multiplexing proxy core                       |
| [`packages/registry`](packages/registry)             | Server config registry with pre-defined configs   |
| [`packages/claude-code`](packages/claude-code)       | Claude Code editor integration                    |
| [`packages/config-default`](packages/config-default) | Default server configs (vtsls + eslint for TS/JS) |

## Quick Start

### Standalone (npm)

Requires Node.js >= 24.0.0. Install the default config package with vtsls
and ESLint:

```sh
pnpm add -g lsp-proxy-config-default
```

The `postinstall` script generates plugin files automatically. Then apply
the prerequisite patch and register the plugin in Claude Code:

```sh
pnpm dlx tweakcc --apply --patches "fix-lsp-support"
```

```
/plugin marketplace add /absolute/path/to/global/lsp-proxy-config-default
/plugin install lsp-proxy@lsp-proxy
```

Disable any conflicting LSP plugins:

```
/plugin disable vtsls@claude-code-lsps
```

See [`packages/config-default`](packages/config-default) for details and
custom config packages.

### From source

```sh
pnpm install
pnpm build
```

## Usage with Claude Code

### Prerequisites

Apply the `fix-lsp-support` patch from
[tweakcc](https://github.com/Piebald-AI/tweakcc) before installing the proxy
plugin. The patch removes validation guards that reject unimplemented config
fields (`restartOnCrash`, `startupTimeout`, `shutdownTimeout`) and injects
automatic `textDocument/didOpen` before LSP requests:

```sh
pnpm dlx tweakcc --apply --patches "fix-lsp-support"
```

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

To use different LSP servers, create your own config package. See
[`packages/config-default`](packages/config-default) for a step-by-step
guide and the full server config schema in
[`packages/proxy`](packages/proxy).

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
pnpm build       # type-check + lint + test + pack
```

## Roadmap

See [AGENTS.md](./AGENTS.md) for milestones and design context.
