# lsp-proxy-config-default

## 0.2.0

### Minor Changes

- fc541e8: Add Vue support: Volar for `.vue`, vtsls holding the TypeScript project behind
  it with `@vue/typescript-plugin` loaded, and the bridge that carries Volar's
  tsserver requests between them.

### Patch Changes

- 4c3943b: Add an end-to-end suite that installs the packed tarballs into a throwaway npm
  project and drives the proxy they generate, asserting that a single-file
  component reaches both linters and that the published package still carries the
  vtsls override. Nothing before it exercised an install, so the two bugs that
  made the published package inert — resolution that assumed pnpm's layout, and a
  copy that dropped `servers/` from the tarball — were only ever visible by hand.
- 3e4282d: Publish `servers/vtsls.json`, which no released tarball has carried. The copy
  into `dist/source` flattened it to the root, and `files` names the `servers`
  directory, so npm found nothing to pack: the published package had no vtsls
  override at all, leaving `.vue` unrouted to vtsls and `@vue/typescript-plugin`
  unloaded, which is every command the Volar bridge forwards.
- lsp-proxy-claude-code@0.1.1
