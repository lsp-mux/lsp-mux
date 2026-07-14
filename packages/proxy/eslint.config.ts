import { configure, defaultEntryPoints } from '@gtbuchanan/eslint-config';
import type { Linter } from 'eslint';

const config: Promise<Linter.Config[]> = configure({
  entryPoints: [...defaultEntryPoints, 'test/helpers/mock-server.ts'],
  tsconfigRootDir: import.meta.dirname,
});

export default config;
