# lsp-proxy-claude-code

Claude Code editor integration for [lsp-proxy](../proxy). Provides the
`generate-claude-plugin` binary that produces the plugin artifacts Claude
Code needs to load the proxy as an LSP server.

## Usage

Add this package as a dependency of your config package (see
[`lsp-proxy-config-default`](../config-default) for an example), then run:

```sh
pnpm exec generate-claude-plugin
```

The binary reads `.lsp-proxy.json` and `servers/` from the current
directory and writes three files:

| Output | Purpose |
|--------|---------|
| `.lsp.json` | LSP server registration — `command`, `args`, `extensionToLanguage`, `transport` |
| `.claude-plugin/plugin.json` | Plugin name, version, description |
| `.claude-plugin/marketplace.json` | Local marketplace metadata |

The generated `.lsp.json` contains absolute paths to the proxy entry point
and config directory. Re-run the command if you move the directory.

## Generated `.lsp.json`

```json
{
  "lsp-proxy": {
    "command": "node",
    "args": ["/absolute/path/to/proxy/dist/main.js", "--config-dir", "/absolute/path/to/config"],
    "extensionToLanguage": { ".ts": "typescript", ".js": "javascript" },
    "transport": "stdio",
    "initializationOptions": {},
    "settings": {},
    "maxRestarts": 0
  }
}
```

`maxRestarts` is set to `0` because the proxy manages child server
restarts internally.
