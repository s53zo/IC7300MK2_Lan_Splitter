'use strict';
const js = require('@eslint/js');
const globals = require('globals');
module.exports = [
    { ignores: ['node_modules/**', '.omx/**'] },
    js.configs.recommended,
    { files: ['desktop/renderer.js'], languageOptions: { globals: globals.browser } },
    {
        files: ['**/*.js', '**/*.cjs'],
        languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: globals.node },
        rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none', varsIgnorePattern: '^_' }] },
    },
];
