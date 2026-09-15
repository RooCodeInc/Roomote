import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    watch: false,
    environment: 'node',
    globalSetup: './vitest.setup.server.ts',
    // Integration files share one database and may delete each other's fixtures.
    fileParallelism: false,
    reporters: ['dot'],
  },
});
