---
---

Update `vscode-languageserver-protocol`, which only the end-to-end client uses,
to v3.18.4. Its new exports map publishes the Node entry as
`vscode-languageserver-protocol/node` and no longer resolves the `node.js` deep
path, so the client imports the exported subpath instead.

No release: the dependency is dev-only.
