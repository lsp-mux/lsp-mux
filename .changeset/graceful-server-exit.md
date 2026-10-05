---
'lsp-proxy': patch
---

Let the language servers act on `exit` before the proxy kills them. The
teardown wrote the notification and disposed in the same synchronous turn, so
the signal reached each child before the bytes did and every server stopped by
`SIGTERM`. A server killed that way never stops what it started: vtsls runs
tsserver as its own child, and orphans it.

Each server now gets five seconds to exit on its own, and is killed only if it
spends them. The teardown sends the `exit` itself rather than forwarding the
client's, so a closed connection and a last server stopping stop them the same
way. `dispose()` stays synchronous for its callers; `start()` resolves once the
servers are gone, which is what the proxy's own process already waits on.
