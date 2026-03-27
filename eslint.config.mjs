import { defineConfig } from 'eslint/config';
import { flatConfigs as importPluginConfigs } from 'eslint-plugin-import-x';
import nodePlugin from 'eslint-plugin-n';
import 'eslint-plugin-only-warn';
import { configs as pnpmPluginConfigs } from 'eslint-plugin-pnpm';
import stylistic from '@stylistic/eslint-plugin';
import vitest from '@vitest/eslint-plugin';
import { configs as typescriptPluginConfigs } from 'typescript-eslint';

export default defineConfig([
  typescriptPluginConfigs.strictTypeChecked,
  typescriptPluginConfigs.stylisticTypeChecked,
  stylistic.configs.customize({ semi: true }),
  importPluginConfigs.recommended,
  importPluginConfigs.typescript,
  nodePlugin.configs['flat/recommended-module'],
  ...pnpmPluginConfigs.json,
  ...pnpmPluginConfigs.yaml,
  {
    files: ['**/package.json', 'pnpm-workspace.yaml'],
    extends: [typescriptPluginConfigs.disableTypeChecked],
  },
  {
    rules: {
      // Justification: Redundant with import-x/no-unresolved + TypeScript module resolution
      'n/no-missing-import': 'off',
      // Justification: Redundant with import-x/no-extraneous-dependencies
      'n/no-unpublished-import': 'off',
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      // Justification: Use type-safe alternatives (satisfies, generics, narrowing)
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
    },
  },
  {
    files: ['src/main.ts', 'src/generate-plugin.ts', 'test/helpers/mock-server.ts'],
    rules: {
      // Justification: Entry points and test harness — process.exit() is the correct shutdown mechanism
      'n/no-process-exit': 'off',
    },
  },
  {
    settings: {
      'import-x/resolver': {
        typescript: {
          project: './tsconfig.json',
        },
      },
    },
  },
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.config.*'],
          defaultProject: 'tsconfig.root.json',
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['test/**/*.ts'],
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
    },
  },
  {
    ignores: ['dist/'],
  },
]);
