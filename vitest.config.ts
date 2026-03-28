import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      cleanOnRerun: false,
      enabled: true,
      include: ['packages/*/src/**'],
      reporter: ['html', 'lcov'],
      reportsDirectory: 'dist/coverage',
    },
    include: ['packages/*/test/**/*.test.ts'],
    mockReset: true,
    unstubEnvs: true,
  },
});
