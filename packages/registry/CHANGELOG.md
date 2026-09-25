# lsp-proxy-registry

## 0.2.0

### Minor Changes

- 2e7d91c: Route `.vue` files to the `eslint` and `oxlint` entries, which read the script
  block of a single-file component. oxlint's Vue rules come from `"plugins":
  ["vue"]` in the project's own `.oxlintrc.json` rather than the `--vue-plugin`
  CLI flag, which the language server ignores; ESLint's take
  `vue-eslint-parser`, and a file its flat config does not match stays silent
  rather than erroring.
- f36c982: Add a `vue` entry for `@vue/language-server`, routing `.vue` files to it. A
  config naming it also needs vtsls to load `@vue/typescript-plugin`, without
  which the commands the Vue server forwards do not exist.

### Patch Changes

- 24c67bc: List the `vue` entry in the README's pre-defined servers table, and sort that
  table by name.
- d7a38fa: Resolve a server's npm package from any ancestor `node_modules`, the way Node
  resolves a module, rather than only the config directory's own. npm and yarn
  hoist a package's dependencies to the project root, so a config package
  installed from the registry had neither a `node_modules` to validate against
  nor an entry point at the path its launch arguments named: the `postinstall`
  that generates the plugin files failed, and past that the servers spawned
  against paths nothing was at. Only pnpm's symlinked workspace layout put them
  where both lookups expected.
