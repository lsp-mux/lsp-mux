# lsp-proxy-config-default

Default [lsp-proxy](../proxy) config package for
[Claude Code](https://docs.anthropic.com/en/docs/claude-code). Bundles
vtsls and ESLint for TypeScript/JavaScript development — works out of
the box with no additional configuration.

## What's included

- **vtsls** — TypeScript / JavaScript language intelligence
  (`.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.mjs`, `.cts`, `.cjs`)
- **eslint** — ESLint diagnostics for the same file types

Server configs come from the [registry](../registry). Override any
setting by adding a `servers/vtsls.json` or `servers/eslint.json` file.

## Standalone installation

Install the package globally and point Claude Code at it:

```sh
pnpm add -g lsp-proxy-config-default
```

The `postinstall` script automatically generates the plugin files. Then
register the plugin in Claude Code:

```
/plugin marketplace add /absolute/path/to/global/lsp-proxy-config-default
/plugin install lsp-proxy@lsp-proxy
```

Disable any conflicting LSP plugins:

```
/plugin disable vtsls@claude-code-lsps
```

## Development usage

When working from the monorepo, plugin files are generated as part of the
build:

```sh
pnpm build
```

To regenerate manually:

```sh
pnpm -C packages/config-default generate-plugin
```

Generated files contain absolute paths. Re-run `generate-plugin` if you
move the directory.

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

Add generate and postinstall scripts to `package.json`:

```json
{
  "scripts": {
    "generate-plugin": "generate-claude-plugin",
    "postinstall": "generate-claude-plugin"
  }
}
```

Then `pnpm generate-plugin` and point Claude Code at the output.
