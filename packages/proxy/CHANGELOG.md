# lsp-proxy

## 0.2.0

### Minor Changes

- 7904951: Resolve relative paths inside a server's `settings` against the config
  directory, as `command` and `args` already were. A server that reads a path
  from its settings can now be configured portably.
- 15913e0: Add `bridges` config, which answers one server's `tsserver/request`
  notifications from another rather than passing them to a client that cannot
  serve them. This is what Volar 3 needs from its editor.

### Patch Changes

- 84f861a: Read and write the `tsserver` bridge's notifications in the shape they
  actually arrive: the tuple is wrapped in the params array, because
  vscode-languageserver packs a notification's single argument that way. The
  bridge previously rejected every real `tsserver/request` as malformed.
- 95f86ab: Wait two minutes for a server's `initialize` rather than the thirty seconds
  every other proxy-internal request gets, so a cold start that loads a
  TypeScript project while three other servers start alongside it is not read as
  a failed start and retried onto an already busy machine.
- 8b6103a: Start an idle server for proxy-internal requests, so a diagnostics pull that
  arrives before any document opens starts the server and waits for it rather
  than answering empty.
- 9f65cdf: Log how long each server's `initialize` took, so the budget the handshake is
  held to can be judged against what starts actually cost on a given machine
  rather than guessed at.
- 7ed8f49: Answer `InvalidRequest` to a client request whose ID carries the proxy's
  `__proxy:` prefix, and drop a `$/cancelRequest` naming one. Such a request
  used to route to a child server whose answer the proxy's own request channel
  then swallowed, leaving the client waiting.
- d7a38fa: Resolve a server's npm package from any ancestor `node_modules`, the way Node
  resolves a module, rather than only the config directory's own. npm and yarn
  hoist a package's dependencies to the project root, so a config package
  installed from the registry had neither a `node_modules` to validate against
  nor an entry point at the path its launch arguments named: the `postinstall`
  that generates the plugin files failed, and past that the servers spawned
  against paths nothing was at. Only pnpm's symlinked workspace layout put them
  where both lookups expected.
- 4ae3524: Stop the language servers when the client shuts the proxy down over the
  protocol. `shutdown` moves the proxy to its stopped state, where the `exit`
  that follows closed the client reader and nothing else: the servers were never
  told to exit and never disposed, so they outlived the proxy that started them.
  `exit` now tears them down from that state as it already did from the running
  one.
  
  The teardown had read "already done" off that same stopped state, which made it
  a no-op on every path reaching it after a shutdown, including a client that
  closes the connection rather than sending `exit`. Disposal is now a state of
  its own.
- Updated dependencies [2e7d91c]
- Updated dependencies [24c67bc]
- Updated dependencies [d7a38fa]
- Updated dependencies [f36c982]
  - lsp-proxy-registry@0.2.0
