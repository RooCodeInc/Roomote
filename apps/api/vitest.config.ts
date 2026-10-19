import { configDefaults, defineConfig } from 'vitest/config';

const globalIntegrationGrantTests = [
  'src/handlers/credential-egress/__tests__/credential-egress.test.ts',
  'src/handlers/credential-egress-proxy/__tests__/credential-egress-proxy.test.ts',
  'src/handlers/mcp/http-integrations/auth.test.ts',
  'src/handlers/mcp/http-integrations/session-grants.test.ts',
];

// These real-DB suites replace or delete the singleton deployment settings row.
// Keep both their fixture reads and writes outside the parallel API project.
const singletonDeploymentSettingsTests = [
  'src/handlers/mcp/__tests__/models.access.test.ts',
  'src/handlers/sessions/model-selection.access.test.ts',
  'src/handlers/slack/events/member-joined.test.ts',
  'src/handlers/tasks/__tests__/manager-slack-target.test.ts',
];

export default defineConfig({
  test: {
    globals: true,
    watch: false,
    reporters: ['dot'],
    projects: [
      {
        extends: true,
        test: {
          name: 'api',
          exclude: [
            ...configDefaults.exclude,
            ...globalIntegrationGrantTests,
            ...singletonDeploymentSettingsTests,
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'api-singleton-deployment-settings',
          include: singletonDeploymentSettingsTests,
          sequence: { groupOrder: 1 },
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'api-global-integration-grants',
          include: globalIntegrationGrantTests,
          // Deployment-visible grants are intentionally global. Keep suites
          // that enumerate them from observing another file's live fixture.
          sequence: { groupOrder: 2 },
          fileParallelism: false,
        },
      },
    ],
  },
});
