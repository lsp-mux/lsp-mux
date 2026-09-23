---
'lsp-proxy': patch
---

Wait two minutes for a server's `initialize` rather than the thirty seconds
every other proxy-internal request gets, so a cold start that loads a
TypeScript project while three other servers start alongside it is not read as
a failed start and retried onto an already busy machine.
