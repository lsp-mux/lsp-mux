import { defineConfig } from 'eslint/config';
import rootConfig from '../../eslint.config.mjs';

export default defineConfig([
  ...rootConfig,
  {
    name: 'proxy/bin-shebang',
    files: ['src/generate-plugin.ts'],
    rules: {
      // Justification: Shebang preserved by tsc for the dist bin entry
      'n/hashbang': 'off',
    },
  },
  {
    name: 'proxy/entry-points',
    files: ['src/main.ts', 'src/generate-plugin.ts', 'test/helpers/mock-server.ts'],
    rules: {
      // Justification: Entry points and test harness — process.exit() is the correct shutdown mechanism
      'n/no-process-exit': 'off',
    },
  },
]);
