# claude-lsp-proxy

An LSP proxy for Claude Code. Sits between Claude Code and a child LSP server,
adding transparent crash recovery with document state replay.

## Problem

Claude Code's LSP plugin system has no lifecycle recovery — a crashed LSP
server requires restarting Claude Code entirely.

## How It Works

The proxy presents as a single LSP server over stdio. It spawns a child LSP
server, forwards all JSON-RPC messages bidirectionally, and tracks document
state. If the child server crashes, the proxy automatically restarts it with
exponential backoff and replays the current document state so the client never
notices.

```
Claude Code (stdio) <--> claude-lsp-proxy <--> child LSP server (e.g. vtsls)
```

## Setup

```sh
pnpm install
pnpm build
```

## Configuration

The proxy reads `proxy.config.json` for which server to manage, and loads the
server config from `servers/`.

```jsonc
// proxy.config.json
{
  "servers": ["vtsls"]
}
```

```jsonc
// servers/vtsls.json
{
  "command": "node",
  "args": ["./node_modules/@vtsls/language-server/bin/vtsls.js", "--stdio"],
  "languages": {
    "typescript": [".ts", ".mts", ".cts"],
    "typescriptreact": [".tsx"],
    "javascript": [".js", ".mjs", ".cjs"],
    "javascriptreact": [".jsx"]
  },
  "transport": "stdio"
}
```

## Usage with Claude Code

Generate the plugin files, then point Claude Code at the proxy:

```sh
pnpm generate-plugin
```

This creates `.lsp.json` and `.claude-plugin/plugin.json` from your
`proxy.config.json` and `servers/*.json` configs.

### Dev/testing (current session only)

```sh
claude --plugin-dir /path/to/claude-lsp-proxy
```

### Persistent (local marketplace)

Add to `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "claude-lsp-proxy": {
      "source": {
        "source": "directory",
        "path": "/absolute/path/to/claude-lsp-proxy"
      }
    }
  },
  "enabledPlugins": {
    "lsp-proxy@claude-lsp-proxy": true
  }
}
```

Then run `/reload-plugins` in Claude Code.

### Conflicting plugins

Disable or remove individual LSP plugins that handle the same file types so
the proxy handles them exclusively:

```json
{
  "enabledPlugins": {
    "vtsls@claude-code-lsps": false,
    "lsp-proxy@claude-lsp-proxy": true
  }
}
```

## Testing

```sh
pnpm test        # vitest only
pnpm build       # type-check + emit + test
```

## Roadmap

See [AGENTS.md](./AGENTS.md) for the full design and milestone plan.
