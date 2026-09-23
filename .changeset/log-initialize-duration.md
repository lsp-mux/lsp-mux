---
'lsp-proxy': patch
---

Log how long each server's `initialize` took, so the budget the handshake is
held to can be judged against what starts actually cost on a given machine
rather than guessed at.
