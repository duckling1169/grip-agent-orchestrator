import js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import prettier from 'eslint-config-prettier/flat'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig(
  globalIgnores(['dist', 'web/dist', 'test-results', '**/node_modules', 'playwright-report', 'coverage']),
  js.configs.recommended,
  {
    files: ['**/*.{js,cjs,mjs}'],
    ignores: ['web/public/sw.js'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['web/public/sw.js'],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts', 'tests/**/*.ts', 'playwright.config.ts', 'vitest.config.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: { parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname } },
  },
  {
    files: ['web/**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommendedTypeChecked, reactHooks.configs.flat.recommended],
    languageOptions: { parserOptions: { project: './web/tsconfig.json', tsconfigRootDir: import.meta.dirname } },
  },
  {
    rules: {
      // Promise-based adapters and test doubles deliberately use async for synchronous implementations.
      '@typescript-eslint/require-await': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Adapted from airport-simulator/eslint.config.ts.
      'max-lines': ['warn', { max: 300, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ['src/errors.ts', 'src/workers/activity.ts'],
    rules: {
      // Error and activity summaries intentionally coerce unknown payload values to strings.
      '@typescript-eslint/no-base-to-string': 'off',
    },
  },
  prettier,
)
