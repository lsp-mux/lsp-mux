---
'lsp-proxy': minor
---

Add `bridges` config, which answers one server's `tsserver/request`
notifications from another rather than passing them to a client that cannot
serve them. This is what Volar 3 needs from its editor.
