import { configure } from '@gtbuchanan/eslint-config';
import type { Linter } from 'eslint';

const base = await configure({ tsconfigRootDir: import.meta.dirname });

const config: Linter.Config[] = [
  ...base,
  // entries.generated.ts is codegen output (gitignored, rewritten by the
  // build). Linting it is noise and any autofix is wiped on regeneration.
  { ignores: ['src/*.generated.ts'] },
];

export default config;
