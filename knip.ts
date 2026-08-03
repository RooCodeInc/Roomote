import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  workspaces: {
    // ── Root ──────────────────────────────────────────────
    '.': {
      project: ['scripts/**/*.ts'],
    },

    // ── Apps ──────────────────────────────────────────────
    'apps/api': {
      project: ['src/**/*.ts'],
    },
    'apps/bullmq': {
      project: ['src/**/*.ts'],
    },
    'apps/controller': {
      entry: [],
      project: ['src/**/*.ts'],
      // Loaded by the Daytona SDK through a bundler-evading dynamic require
      // when uploading files; shipped as a runtime dep next to the bundled
      // dist in .docker/app/Dockerfile.
      ignoreDependencies: ['form-data'],
    },
    'apps/dev': {
      project: ['src/**/*.ts'],
      ignore: ['src/services/worker-release.ts'],
      ignoreBinaries: ['pm2', 'ngrok'],
    },
    // Self-contained Mintlify docs site. It has no TypeScript project; the
    // `mint` CLI is installed globally.
    'apps/docs': {
      entry: [],
      project: [],
      ignoreBinaries: ['mint'],
    },
    'apps/e2e': {
      entry: ['src/run-direct-suite.ts', 'src/suites/**/*.ts'],
      project: ['src/**/*.ts'],
    },
    'apps/preview-proxy': {
      project: ['src/**/*.ts'],
    },
    'apps/web': {
      entry: [
        'src/app/**/{page,layout,loading,error,not-found,default,template,route,middleware}.{ts,tsx}',
        'next.config.*',
        'postcss.config.*',
        '.storybook/**/*.{ts,tsx}',
        'src/**/*.stories.{ts,tsx}',
      ],
      project: ['src/**/*.{ts,tsx}'],
      // Used to satisfy vulnerable peer resolution edges in Storybook/Sentry, not imported directly.
      ignoreDependencies: ['webpack'],
    },
    'apps/worker': {
      entry: ['scripts/**/*.ts'],
      project: ['src/**/*.ts', 'scripts/**/*.ts'],
      ignoreBinaries: [
        'rg',
        'mysqladmin',
        'pg_isready',
        'ps',
        'python',
        'fc-cache',
        'dpkg-query',
      ],
    },

    // ── Packages ─────────────────────────────────────────
    'packages/auth': {
      project: ['src/**/*.ts'],
    },
    'packages/cloud-agents': {
      entry: ['evals/router/**/*.ts'],
      project: ['src/**/*.ts'],
      ignoreBinaries: [
        'evals/router/promptfooconfig.ts',
        'evals/router/promptfooconfig.followup.ts',
      ],
    },
    'packages/communication': {
      project: ['src/**/*.ts'],
    },
    'packages/compute-providers': {
      project: ['src/**/*.ts'],
    },
    'packages/config-eslint': {
      project: ['**/*.js'],
    },
    'packages/config-typescript': {
      ignoreDependencies: ['next'],
    },
    'packages/db': {
      project: ['src/**/*.ts'],
      drizzle: false,
    },
    'packages/env': {
      project: ['src/**/*.ts'],
    },
    'packages/feature-flags': {
      project: ['src/**/*.ts'],
    },
    'packages/github': {
      project: ['src/**/*.ts'],
      ignoreBinaries: ['gh'],
    },
    'packages/linear': {
      project: ['src/**/*.ts'],
    },
    'packages/redis': {
      project: ['src/**/*.ts'],
    },
    'packages/sdk': {
      project: ['src/**/*.ts'],
    },
    'packages/slack': {
      project: ['src/**/*.ts'],
    },
    'packages/telemetry': {
      project: ['src/**/*.ts'],
    },
    'packages/types': {
      project: ['src/**/*.ts'],
    },
  },

  ignoreDependencies: [
    // Imported via CSS (@import 'tailwindcss'), not traceable by knip.
    'tailwindcss',
    'tw-animate-css',
  ],
};

export default config;
