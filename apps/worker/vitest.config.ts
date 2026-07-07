import { configDefaults, defineConfig } from 'vitest/config';

const includeIntegrationTests =
  process.env.RUN_HARNESS_INTEGRATION_TESTS === '1';

export default defineConfig({
  test: {
    globals: true,
    watch: false,
    reporters: ['dot'],
    exclude: includeIntegrationTests
      ? configDefaults.exclude
      : [...configDefaults.exclude, '**/*.integration.test.ts'],
  },
});
