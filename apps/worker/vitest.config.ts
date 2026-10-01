import { configDefaults, defineConfig } from 'vitest/config';

const includeIntegrationTests =
  process.env.RUN_HARNESS_INTEGRATION_TESTS === '1';

export default defineConfig({
  test: {
    globals: true,
    watch: false,
    reporters: ['dot'],
    // The worker suite has many process- and service-heavy files. Unbounded
    // forks intermittently exit under CI resource pressure after assertions
    // have passed, so keep concurrency aligned with the web test projects.
    maxWorkers: 4,
    exclude: includeIntegrationTests
      ? configDefaults.exclude
      : [...configDefaults.exclude, '**/*.integration.test.ts'],
  },
});
