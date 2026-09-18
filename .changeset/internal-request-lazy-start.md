---
'lsp-proxy': patch
---

Start an idle server for proxy-internal requests, so a diagnostics pull that
arrives before any document opens starts the server and waits for it rather
than answering empty.
