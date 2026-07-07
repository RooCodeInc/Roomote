import { config } from './packages/config-eslint/base.js';

/** @type {import("eslint").Linter.Config} */
export default [
  ...config,
  {
    ignores: [
      '.docker/**',
      '.github/**',
      '.husky/**',
      '.roomote/**',
      '.turbo/**',
      '.vscode/**',
      'apps/**',
      'node_modules/**',
      'packages/**',
      'scripts/**',
    ],
  },
];
