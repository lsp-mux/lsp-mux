# vscode-eslint-extracted

ESLint language server extracted from the
[VS Code ESLint extension](https://github.com/microsoft/vscode-eslint).

## Why?

The commonly used [`vscode-langservers-extracted`](https://github.com/hrsh7th/vscode-langservers-extracted)
package (v4.10.0) bundles an ESLint server that doesn't support ESLint 10's
flat config — it crashes on `eslintConfig.plugins` iteration. The Zed fork
(`@zed-industries/vscode-langservers-extracted`) intentionally
[removed ESLint](https://github.com/zed-industries/vscode-langservers-extracted/commit/d93b048).

This package downloads the pre-built `eslintServer.js` from the official
VS Code ESLint extension VSIX on `postinstall`, giving us a server that
supports ESLint 6–10 including flat config.

## How it works

`pnpm install` triggers `scripts/download.ts` which:

1. Downloads the VSIX from the VS Marketplace (pinned version)
1. Extracts `extension/server/out/eslintServer.js` using `yauzl`
1. Places it at `dist/eslintServer.js`

The download is skipped if the file already exists. Delete `dist/` to
force a re-download.

## License

The extracted server code is MIT licensed by Microsoft. See [LICENSE](./LICENSE).
