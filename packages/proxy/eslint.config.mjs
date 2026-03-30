import { defineConfig } from 'eslint/config';
import rootConfig from '../../eslint.config.mjs';

export default defineConfig([
  ...rootConfig,
  {
    name: 'proxy/entry-points',
    files: ['test/helpers/mock-server.ts'],
    rules: {
      // Justification: Test harness entry point — process.exit() is the correct shutdown mechanism
      'n/no-process-exit': 'off',
    },
  },
]);
