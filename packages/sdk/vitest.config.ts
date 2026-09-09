import { configDefaults, defineConfig } from 'vitest/config';

const globalDbStateTests = [
  'src/server/lib/source-control-connection.test.ts',
  'src/server/automations/__tests__/ci-failure-triage-routing.integration.test.ts',
  'src/server/lib/task-runs/__tests__/platform-issue-alert-delivery.test.ts',
];

export default defineConfig({
  test: {
    globals: true,
    watch: false,
    environment: 'node',
    passWithNoTests: true,
    globalSetup: './vitest.setup.server.ts',
    projects: [
      {
        extends: true,
        test: {
          name: 'sdk',
          exclude: [...configDefaults.exclude, ...globalDbStateTests],
        },
      },
      {
        extends: true,
        test: {
          name: 'sdk-global-db-state',
          include: globalDbStateTests,
          // These tests mutate deployment settings or shared installations.
          // Run them after parallel suites that seed their own installations.
          sequence: { groupOrder: 1 },
          fileParallelism: false,
        },
      },
    ],
  },
});
