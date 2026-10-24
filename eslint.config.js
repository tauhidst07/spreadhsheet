import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

// Files that must stay pure: no React, no DOM, no browser globals.
const PURE = ['src/engine/**/*.js', 'src/ai/runtime.js', 'src/ai/format.js', 'src/ai/contract.js']

export default defineConfig([
  globalIgnores(['dist', 'dist-measure']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]', argsIgnorePattern: '^_' }],
    },
  },
  {
    files: PURE,
    languageOptions: { globals: { ...globals.es2021 } },
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['react', 'react-*', 'react/*', '*.jsx', '**/grid/*'], message: 'Engine, executor and applier must stay pure (no React/DOM).' }] }],
    },
  },
  {
    files: ['vite.config.js', 'server/**/*.{js,mjs}', 'scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
])
