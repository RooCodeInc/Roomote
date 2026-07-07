import { nextJsConfig } from '@roomote/config-eslint/next-js';

/** @type {import("eslint").Linter.Config} */
export default [
  ...nextJsConfig,
  {
    ignores: ['next-env.d.ts', 'storybook-static/**', '.source/**'],
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@roomote/env',
              message:
                'Import env helpers from apps/web/src/lib/server/env.ts instead.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "ImportExpression[source.value='@roomote/env']",
          message:
            'Import env helpers from apps/web/src/lib/server/env.ts instead.',
        },
      ],
    },
  },
  {
    files: ['src/lib/server/env.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
    },
  },
];
