---
'lsp-proxy-registry': minor
---

Add a `vue` entry for `@vue/language-server`, routing `.vue` files to it. A
config naming it also needs vtsls to load `@vue/typescript-plugin`, without
which the commands the Vue server forwards do not exist.
