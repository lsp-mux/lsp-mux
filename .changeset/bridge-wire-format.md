---
'lsp-proxy': patch
---

Read and write the `tsserver` bridge's notifications in the shape they
actually arrive: the tuple is wrapped in the params array, because
vscode-languageserver packs a notification's single argument that way. The
bridge previously rejected every real `tsserver/request` as malformed.
