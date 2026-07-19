import { configure } from '@gtbuchanan/eslint-config';
import type { Linter } from 'eslint';

const base = await configure({ tsconfigRootDir: import.meta.dirname });

const config: Linter.Config[] = [
  ...base,
  /*
   * Generated Claude Code plugin artifacts (postinstall codegen with
   * machine-specific absolute paths) — git-ignored, never linted.
   */
  { ignores: ['.claude-plugin/', '.lsp.json'] },
];

export default config;
