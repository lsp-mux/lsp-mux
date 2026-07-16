# lsp-proxy

Multiplexing LSP proxy. Presents as a single LSP server over stdio while
internally managing multiple language servers per file type.

- Routes requests by file extension to one or more child servers
- Merges diagnostics from multiple servers (push and pull models)
- Delivers per-server settings via `workspace/configuration`
- Restarts crashed servers with exponential backoff and document replay
- Watches workspace files and resyncs document state on external changes
- Compensates for clients missing `didChangeWatchedFiles` or pull diagnostics

Typically consumed via a config package (see
[`lsp-proxy-config-default`](../config-default)) rather than installed
directly.

## CLI

The proxy is launched by the generated `.lsp.json` plugin config, but you
can also run it directly for debugging:

```sh
node node_modules/lsp-proxy/dist/main.js --config-dir /path/to/config
```

| Flag                  | Description                                                                          |
| --------------------- | ------------------------------------------------------------------------------------ |
| `--config-dir <path>` | Directory containing `.lsp-proxy.json` and `servers/`. Defaults to the package root. |
| `--log-dir <path>`    | Log output directory. Overrides `logDir` in config.                                  |

Logs are written to `<logDir>/<timestamp>-<pid>.log`. The default log
directory is `$XDG_DATA_HOME/lsp-proxy/logs` on Linux/macOS and
`%LOCALAPPDATA%\lsp-proxy\logs` on Windows.

## Configuration

### `.lsp-proxy.json`

```jsonc
{
  // Required: server names to load (minimum 1, unique)
  "servers": ["vtsls", "eslint"],

  // Optional: DEBUG, INFO (default), WARN, ERROR
  // Watched at runtime -- changes apply without restart
  "logLevel": "INFO",

  // Optional: override default log directory
  "logDir": "/path/to/logs",

  // Optional: glob patterns to exclude from file watching
  // Merged with built-in defaults (node_modules, .git, dist, etc.)
  "watcherExclude": ["**/build/**"],
}
```

Place an optional `.lsp-proxy.local.json` alongside for local overrides
(deep-merged on top of the base config, typically git-ignored).

### `servers/<name>.json`

Each server config is resolved from the
[registry](../registry) first, then deep-merged with
`servers/<name>.json` if present:

```jsonc
{
  // Required
  "command": "node",
  "args": ["./node_modules/@vtsls/language-server/bin/vtsls.js", "--stdio"],
  "languages": {
    "typescript": [".ts", ".tsx"],
    "javascript": [".js", ".jsx"],
  },
  "transport": "stdio",

  // Optional: delivered via workspace/configuration
  // When a server requests a section key, the matching top-level key is
  // returned. Otherwise the full object is returned with workspaceFolder
  // injected.
  "settings": {
    "validate": "on",
    "run": "onType",
  },

  // Optional: per-notification log level overrides
  "notifications": {
    "eslint/status": { "logLevel": "DEBUG" },
  },
}
```

Relative paths in `command` and `args` are resolved against the config
directory at load time.

Requires Node.js >= 24.0.0.
