import { configure } from '@gtbuchanan/eslint-config';
import type { Linter } from 'eslint';

const config: Promise<Linter.Config[]> = configure({
  tsconfigRootDir: import.meta.dirname,
});

export default config;
