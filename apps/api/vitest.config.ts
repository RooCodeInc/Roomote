import { configDefaults, defineConfig } from 'vitest/config';

const globalIntegrationGrantTests = [
  'src/handlers/credential-egress/__tests__/credential-egress.test.ts',
  'src/handlers/credential-egress-proxy/__tests__/credential-egress-proxy.test.ts',
  'src/handlers/mcp/http-integrations/auth.test.ts',
  'src/handlers/mcp/http-integrations/session-grants.test.ts',
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
          exclude: [...configDefaults.exclude, ...globalIntegrationGrantTests],
        },
      },
      {
        extends: true,
        test: {
          name: 'api-global-integration-grants',
          include: globalIntegrationGrantTests,
          // Deployment-visible grants are intentionally global. Keep suites
          // that enumerate them from observing another file's live fixture.
          sequence: { groupOrder: 1 },
          fileParallelism: false,
        },
      },
    ],
  },
});
