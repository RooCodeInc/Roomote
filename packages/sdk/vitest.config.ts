import { configDefaults, defineConfig } from 'vitest/config';

const globalDbStateTests = [
  'src/server/automations/__tests__/ci-failure-triage-routing.integration.test.ts',
  'src/server/lib/__tests__/credential-egress.integration.test.ts',
  'src/server/lib/__tests__/service-credentials.test.ts',
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
          // These tests delete shared rows or assert deployment-wide lookups.
          // Run them after parallel suites that seed their own installations.
          sequence: { groupOrder: 1 },
          fileParallelism: false,
        },
      },
    ],
  },
});
