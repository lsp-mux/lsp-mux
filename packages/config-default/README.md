# lsp-proxy-config-default

Example config package for [lsp-proxy](../proxy). Bundles vtsls and
ESLint for TypeScript/JavaScript development. Use this as a starting point
for your own config package.

## What's included

- **vtsls** — TypeScript / JavaScript language intelligence
  (`.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.mjs`, `.cts`, `.cjs`)
- **eslint** — ESLint diagnostics for the same file types

Server configs come from the [registry](../registry). Override any
setting by adding a `servers/vtsls.json` or `servers/eslint.json` file.

## Usage

```sh
pnpm install
pnpm generate-plugin
```

This produces:

- `.lsp.json` — LSP server registration for Claude Code
- `.claude-plugin/plugin.json` — plugin metadata
- `.claude-plugin/marketplace.json` — local marketplace metadata

Generated files contain absolute paths. Re-run `pnpm generate-plugin` if
you move the directory.

## Files

```
.lsp-proxy.json          # which servers to load
.lsp-proxy.local.json    # local overrides (git-ignored)
servers/                  # per-server config overrides (empty by default)
```

## Creating your own config package

```sh
mkdir my-lsp-config && cd my-lsp-config
pnpm init
pnpm add lsp-proxy lsp-proxy-claude-code
```

Install the LSP servers you need:

```sh
pnpm add @vtsls/language-server     # TypeScript
pnpm add vscode-langservers-extracted  # HTML/CSS
```

Create `.lsp-proxy.json`:

```json
{
  "servers": ["vtsls", "css"]
}
```

For servers not in the registry, create `servers/<name>.json`:

```json
{
  "command": "node",
  "args": ["./node_modules/vscode-langservers-extracted/bin/vscode-css-language-server", "--stdio"],
  "languages": { "css": [".css"], "scss": [".scss"] },
  "transport": "stdio"
}
```

Add a generate script to `package.json`:

```json
{
  "scripts": {
    "generate-plugin": "generate-claude-plugin"
  }
}
```

Then `pnpm generate-plugin` and point Claude Code at the output.
