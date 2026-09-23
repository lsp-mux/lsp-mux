---
'lsp-proxy-registry': minor
---

Route `.vue` files to the `eslint` and `oxlint` entries, which read the script
block of a single-file component. oxlint's Vue rules come from `"plugins":
["vue"]` in the project's own `.oxlintrc.json` rather than the `--vue-plugin`
CLI flag, which the language server ignores; ESLint's take
`vue-eslint-parser`, and a file its flat config does not match stays silent
rather than erroring.
