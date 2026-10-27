---
---

Update TypeScript to v6.0.3, the newest release typescript-eslint supports,
so `@gtbuchanan/tsconfig` 0.2.0 can follow. Under TypeScript 6
`unicorn/consistent-boolean-name` flags the proxy's `tryWatch` helper, which
returns a watcher rather than a boolean, so it is renamed `watchIfExists`.

No release: TypeScript is a dev dependency and the rename is internal.
