---
'lsp-proxy': patch
---

Update `vscode-jsonrpc` to v9. Its exports map publishes the Node entry as
`vscode-jsonrpc/node` and no longer resolves the `vscode-jsonrpc/node.js` deep
path, so the proxy imports the exported subpath instead.
