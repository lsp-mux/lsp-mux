import { defineConfig } from 'eslint/config';
import { flatConfigs as importPluginConfigs } from 'eslint-plugin-import-x';
import nodePlugin from 'eslint-plugin-n';
import 'eslint-plugin-only-warn';
import { configs as pnpmPluginConfigs } from 'eslint-plugin-pnpm';
import stylistic from '@stylistic/eslint-plugin';
import vitest from '@vitest/eslint-plugin';
import { configs as typescriptPluginConfigs } from 'typescript-eslint';

export default defineConfig(
  typescriptPluginConfigs.strictTypeChecked,
  typescriptPluginConfigs.stylisticTypeChecked,
  stylistic.configs.customize({ semi: true }),
  importPluginConfigs.recommended,
  importPluginConfigs.typescript,
  nodePlugin.configs['flat/recommended-module'],
  ...pnpmPluginConfigs.json,
  ...pnpmPluginConfigs.yaml,
  {
    name: 'root/pnpm-disable-type-checked',
    files: ['**/package.json', 'pnpm-workspace.yaml'],
    extends: [typescriptPluginConfigs.disableTypeChecked],
  },
  {
    name: 'root/disable-redundant-node-rules',
    rules: {
      // Justification: Redundant with import-x/no-unresolved + TypeScript module resolution
      'n/no-missing-import': 'off',
      // Justification: Redundant with import-x/no-extraneous-dependencies
      'n/no-unpublished-import': 'off',
      // Justification: Redundant with import-x/no-extraneous-dependencies in a pnpm workspace
      'n/no-extraneous-import': 'off',
    },
  },
  {
    name: 'root/strict-type-assertions',
    files: ['packages/*/src/**/*.ts'],
    rules: {
      // Justification: Use type-safe alternatives (satisfies, generics, narrowing)
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
    },
  },
  {
    name: 'root/typescript-parser',
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.config.*', 'packages/*/*.config.*'],
          defaultProject: 'tsconfig.root.json',
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    name: 'root/vitest',
    files: ['**/test/**/*.ts'],
    extends: [vitest.configs.recommended],
    rules: {
      // Justification: vitest-aware version allows vi.fn() mocks in expect() — see
      // https://github.com/vitest-dev/eslint-plugin-vitest/blob/main/docs/rules/unbound-method.md
      '@typescript-eslint/unbound-method': 'off',
      // Justification: Plugin can't trace test.extend `it` re-exported across modules —
      // see vitest-dev/eslint-plugin-vitest#686
      'vitest/no-standalone-expect': 'off',
      // Justification: vitest-aware version allows vi.fn() mocks in expect() — see
      // https://github.com/vitest-dev/eslint-plugin-vitest/blob/main/docs/rules/unbound-method.md
      'vitest/unbound-method': 'error',
    },
  },
  {
    name: 'root/ignores',
    ignores: ['**/dist/**', '**/tmp-workspace*/**'],
  },
);
