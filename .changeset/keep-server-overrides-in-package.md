---
'lsp-proxy-config-default': patch
---

Publish `servers/vtsls.json`, which no released tarball has carried. The copy
into `dist/source` flattened it to the root, and `files` names the `servers`
directory, so npm found nothing to pack: the published package had no vtsls
override at all, leaving `.vue` unrouted to vtsls and `@vue/typescript-plugin`
unloaded, which is every command the Volar bridge forwards.
