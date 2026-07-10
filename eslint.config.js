'use strict';

// Flat ESLint config. The project's app is now TypeScript (compiled to CJS via
// `bun build`); the reference server under server/ stays plain CommonJS Node.
// The typescript-eslint layer is scoped to *.ts so the plain-JS files (server,
// this config) keep their CommonJS `require` style. Built artifacts (dist/,
// bin/) and sibling projects (web/) are ignored.
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const globals = require('globals');

module.exports = tseslint.config(
  {
    ignores: [
      'node_modules/',
      'dist/',
      'bin/',
      'server/data/',
      'web/',
      '.claude/',
    ],
  },
  js.configs.recommended,
  {
    // Plain Node CommonJS files (server, this config).
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Surface dead code without failing CI; underscore-prefixed args are
      // intentional (Electron IPC handlers ignore the event object).
      'no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // typescript-eslint's recommended layer, scoped to TypeScript sources only.
  ...tseslint.configs.recommended.map((c) => ({ ...c, files: ['**/*.ts'] })),
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
        Bun: 'readonly',
      },
    },
    rules: {
      // TypeScript's own checker handles undefined identifiers; the core rule
      // false-positives on ambient/type-only names.
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  }
);
