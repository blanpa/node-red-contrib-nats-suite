'use strict';

// Flat config required by ESLint 9+ (legacy .eslintrc is unsupported as of
// ESLint 10). Minimal rule set: catch real bugs (no-undef, no-case-declarations,
// no-duplicate-case, ...), warn on unused vars, defer style to Prettier.
const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');

module.exports = [
  { ignores: ['node_modules/', 'coverage/', 'node-red/'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': 'warn',
    },
  },
  prettier,
];
