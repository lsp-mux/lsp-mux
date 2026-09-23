---
'lsp-proxy': patch
---

Answer `InvalidRequest` to a client request whose ID carries the proxy's
`__proxy:` prefix, and drop a `$/cancelRequest` naming one. Such a request
used to route to a child server whose answer the proxy's own request channel
then swallowed, leaving the client waiting.
