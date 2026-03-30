# claude-lsp-proxy

A multiplexing LSP proxy for Claude Code. Presents as a single LSP server
while internally managing multiple language servers per file type, with
transparent crash recovery and document state replay.

## Problem

Claude Code's LSP plugin system has limitations:

- [**One server per file type**](https://github.com/anthropics/claude-code/issues/27692) — can't run vtsls + ESLint for `.ts` files
- **No lifecycle recovery** — a crashed LSP server requires restarting Claude
- **No inter-server communication** — Volar 3 requires forwarding between servers
  (bridging is [planned](./AGENTS.md) but not yet implemented)
- [**Windows `.cmd` spawn**](https://github.com/anthropics/claude-code/issues/16751) — npm shim resolution fails on Windows

## How It Works

The proxy presents as a single LSP server over stdio. It spawns child LSP
servers, routes requests by file type, merges diagnostics, and tracks document
state. If a child server crashes, the proxy restarts it with exponential
backoff and replays open documents.

```
Claude Code (stdio) <--> claude-lsp-proxy <--> vtsls
                                           \-> eslint
```

## Packages

| Package | Description |
|---------|-------------|
| [`packages/proxy`](packages/proxy) | The multiplexing proxy core |
| [`packages/config-default`](packages/config-default) | Default server configs (vtsls + eslint for TS/JS) |

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
claude --plugin-dir /path/to/claude-lsp-proxy/packages/config-default
```

### Persistent (local marketplace)

In Claude Code:

```
/plugin marketplace add /absolute/path/to/packages/config-default
/plugin install lsp-proxy@claude-lsp-proxy
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
pnpm add claude-lsp-proxy
pnpm add vscode-langservers-extracted  # or whatever servers you need
```

Create `proxy.config.json`:

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
  "args": ["./node_modules/eslint-server/dist/eslintServer.js", "--stdio"],
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
pnpm dlx generate-lsp-plugin
claude --plugin-dir /path/to/my-lsp-config
```

## Logging

The proxy logs to `~/.claude/lsp-proxy/logs/<timestamp>.log`. The default level is
INFO.

To change the level at runtime (no restart needed), add `logLevel` to your
`proxy.config.json`:

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
