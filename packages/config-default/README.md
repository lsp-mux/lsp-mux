# lsp-proxy-config-default

Default [lsp-proxy](../proxy) config package. Bundles Volar, vtsls,
ESLint and oxlint, so TypeScript, JavaScript and Vue single-file
components all get language intelligence from one proxy.

The server wiring is plain LSP and holds for any client the proxy
fronts. What is specific to
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) is the
install step below, which generates that editor's plugin files.

## What's included

- **vue** — [Volar](https://github.com/vuejs/language-tools) for `.vue`
- **vtsls** — TypeScript / JavaScript (`.ts`, `.tsx`, `.js`, `.jsx`,
  `.mts`, `.mjs`, `.cts`, `.cjs`), and the TypeScript project behind the
  `.vue` files
- **eslint** — ESLint diagnostics for TypeScript, JavaScript and `.vue`
- **oxlint** — oxlint diagnostics for the same file types, running
  alongside ESLint rather than instead of it

Server configs come from the [registry](../registry), deep-merged with
any `servers/<name>.json` in this directory. Relative paths in
`command`, `args` and anywhere inside `settings` resolve against this
directory, so overrides stay portable.

## How the Vue wiring works

Volar 3 does not talk to a TypeScript server itself. It asks its editor
to run commands against one, and this config points that at vtsls:

- `.lsp-proxy.json` declares a `tsserver` bridge from `vue` to `vtsls`,
  so the proxy answers Volar's `tsserver/request` notifications.
- `servers/vtsls.json` loads `@vue/typescript-plugin` into vtsls's
  tsserver, which is what defines the `_vue:` commands Volar asks for,
  and adds `.vue` to the files vtsls sees.

Three things about that setup are easy to get wrong:

1. **Server order decides routing.** Both `vue` and `vtsls` claim `.vue`,
   and a request goes to the first one listed, so `vue` comes first.
1. **Plugin settings must be nested objects.** vtsls resolves
   `vtsls.tsserver.globalPlugins` by walking the tree, so a flat
   `"vtsls.tsserver.globalPlugins"` key is read as nothing at all — and
   silently, since a plugin that fails to load reports nothing.
1. **The plugin version must match the server.** `@vue/typescript-plugin`
   and `@vue/language-server` are released together and this package pins
   both. A mismatched pair fails as commands that do not exist.

## Linting Vue single-file components

Both linters receive `.vue` files.

oxlint reads the script block under its standard rules with no setup. Its
Vue rules need `"plugins": ["vue"]` in your `.oxlintrc.json`. The
`--vue-plugin` CLI flag has no effect on the language server, which takes
its plugin list from the config file alone.

ESLint reports nothing for a `.vue` file until your flat config matches
one, which takes
[`vue-eslint-parser`](https://github.com/vuejs/vue-eslint-parser) and
usually [`eslint-plugin-vue`](https://eslint.vuejs.org). A file no config
object matches is silent rather than an error, so a project without them
sees no new diagnostics.

## Standalone installation

Install the package globally and point Claude Code at it:

```sh
pnpm add -g lsp-proxy-config-default
```

The `postinstall` script automatically generates the plugin files. Then
register the plugin in Claude Code:

```text
/plugin marketplace add /absolute/path/to/global/lsp-proxy-config-default
/plugin install lsp-proxy@lsp-proxy
```

## Diagnosing the bridge

Set `logLevel` to `DEBUG` in `.lsp-proxy.local.json` to see the proxy
forward each request, as `vue → vtsls: <command>`. To see the payloads
as well, add a `servers/vue.json` with:

```json
{
  "notifications": {
    "tsserver/request": { "logLevel": "DEBUG" }
  }
}
```

That prints the full parameters of every request Volar sends, which is
noisy in normal use but is what makes a mismatch between what Volar
sends and what the bridge expects visible.
