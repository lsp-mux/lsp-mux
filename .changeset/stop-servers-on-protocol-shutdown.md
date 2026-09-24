---
'lsp-proxy': patch
---

Stop the language servers when the client shuts the proxy down over the
protocol. `shutdown` moves the proxy to its stopped state, where the `exit`
that follows closed the client reader and nothing else: the servers were never
told to exit and never disposed, so they outlived the proxy that started them.
`exit` now tears them down from that state as it already did from the running
one.

The teardown had read "already done" off that same stopped state, which made it
a no-op on every path reaching it after a shutdown, including a client that
closes the connection rather than sending `exit`. Disposal is now a state of
its own.
