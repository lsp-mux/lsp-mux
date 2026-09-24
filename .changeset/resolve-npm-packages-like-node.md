---
'lsp-proxy-registry': patch
'lsp-proxy': patch
---

Resolve a server's npm package from any ancestor `node_modules`, the way Node
resolves a module, rather than only the config directory's own. npm and yarn
hoist a package's dependencies to the project root, so a config package
installed from the registry had neither a `node_modules` to validate against
nor an entry point at the path its launch arguments named: the `postinstall`
that generates the plugin files failed, and past that the servers spawned
against paths nothing was at. Only pnpm's symlinked workspace layout put them
where both lookups expected.
