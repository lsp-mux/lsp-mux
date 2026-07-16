import { configure } from '@gtbuchanan/eslint-config';
import type { Linter } from 'eslint';

const base = await configure({ tsconfigRootDir: import.meta.dirname });

const config: Linter.Config[] = [
  ...base,
  {
    /*
     * The test harness exports a `test.extend()` fixture named `it`. The
     * vitest plugin only detects `.extend()` fixtures declared in-file, so it
     * can't tell the imported `it(...)` is a test block and require-hook flags
     * every test as setup. Whitelist it, mirroring how the shared config
     * whitelists it.for/test.for. The glob must match the shared config's
     * test-file patterns so the vitest plugin namespace resolves here.
     */
    files: ['**/test/**/*.ts'],
    rules: {
      /*
       * `@module-tag` is a @gtbuchanan/vitest-config convention for tagging a
       * test module (e.g. `@module-tag slow` for the slow bucket). Preserve
       * the shared config's `defaultValue` tag alongside it.
       */
      'jsdoc/check-tag-names': ['warn', { typed: true, definedTags: ['defaultValue', 'module-tag'] }],
      'vitest/require-hook': ['warn', { allowedFunctionCalls: ['it', 'it.for', 'test.for'] }],
    },
  },
];

export default config;
