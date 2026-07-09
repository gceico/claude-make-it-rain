'use strict';

// Flat ESLint config. The whole project is CommonJS Node (no bundler, no ESM),
// so a single Node profile covers the app, the CLI, the server, and the tests.
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/', 'server/data/'],
  },
  js.configs.recommended,
  {
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
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
