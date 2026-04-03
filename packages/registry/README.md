# lsp-proxy-registry

Server config registry for [lsp-proxy](../proxy). Ships pre-defined
configs for common LSP servers and provides utilities for config lookup,
deep merging, and npm package validation.

## Pre-defined servers

| Name | npm package | Description |
|------|-------------|-------------|
| `vtsls` | `@vtsls/language-server` | TypeScript / JavaScript |
| `eslint` | `@lsp-mux/vscode-eslint-lsp` | ESLint diagnostics |
| `oxlint` | `oxlint` | Oxlint diagnostics |

Configs live in `entries/<name>.json`. Each entry contains the full server
config (`command`, `args`, `languages`, `transport`, `settings`,
`notifications`) plus an optional `npm` field naming the required package.

## How the proxy uses the registry

When the proxy loads a server by name:

1. `lookupRegistryEntry(name)` reads `entries/<name>.json`
1. If the user also provides `servers/<name>.json` in their config dir,
   `deepMerge` overlays the user config on top of the registry entry
1. Registry metadata (`npm`) is stripped via `serverConfigFromEntry`
1. If the entry declares `npm` and the user didn't override `command`,
   `validateNpmPackage` checks that the package is installed locally

## API

```ts
import {
  lookupRegistryEntry,
  serverConfigFromEntry,
  listRegistryEntries,
  deepMerge,
  validateNpmPackage,
} from 'lsp-proxy-registry'
```

- **`lookupRegistryEntry(name)`** — returns the entry object or
  `undefined` if not found
- **`serverConfigFromEntry(entry)`** — strips registry metadata (`npm`)
  and returns server config fields only
- **`listRegistryEntries()`** — returns all available server names
- **`deepMerge(base, override)`** — recursively merges plain objects;
  arrays and scalars replace outright
- **`validateNpmPackage(pkg, configDir, serverName)`** — throws with an
  actionable install command if the package is missing

## Adding a server

Create `entries/<name>.json`:

```json
{
  "npm": "my-language-server",
  "command": "node",
  "args": ["./node_modules/my-language-server/bin/server.js", "--stdio"],
  "languages": {
    "mylang": [".ml"]
  },
  "transport": "stdio"
}
```

The `npm` field is optional — omit it for servers that aren't installed
via npm (e.g., `rust-analyzer`, `gopls`).
