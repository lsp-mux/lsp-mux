---
'lsp-proxy': patch
---

Make the restart cap reachable for a server that crashes after its handshake.
The attempt counter reset the moment a restarted server answered `initialize`,
so a server that came up and died seconds later refunded its budget every
cycle and `maxRetries` never engaged. One proxy session restarted the Vue
language server eighteen times in three minutes, each one logged as attempt
1 of 5, and stopped only when the proxy was torn down.

A server now earns back one spent attempt for every ten seconds it stays up.
One that answers its handshake and then dies keeps spending, so a crash loop
reaches the cap and stops, while a server that runs healthily for a minute has
its whole budget back.
