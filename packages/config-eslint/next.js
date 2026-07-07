import pluginNext from '@next/eslint-plugin-next';
import storybook from 'eslint-plugin-storybook';

import { reactConfig } from './react.js';

/**
 * @type {import("eslint").Linter.Config[]}
 */
export const nextJsConfig = [
  ...reactConfig,
  {
    ignores: ['.next/**'],
  },
  {
    plugins: {
      '@next/next': pluginNext,
    },
    rules: {
      ...pluginNext.configs.recommended.rules,
      ...pluginNext.configs['core-web-vitals'].rules,
    },
  },
  ...storybook.configs['flat/recommended'],
];
