import { resolve } from 'path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
      // Mock the vscode module for tests since it's not available outside
      // VS Code extension context.
      vscode: resolve(__dirname, './src/__mocks__/vscode.ts'),
    },
  },
  test: {
    globals: true,
    watch: false,
    reporters: ['dot'],
    projects: [
      {
        extends: true,
        test: {
          name: 'server',
          include: [
            'src/**/*.test.{js,jsx,ts,tsx}',
            'src/**/*.server.test.{js,jsx,ts,tsx}',
            '!src/**/*.client.test.{js,jsx,ts,tsx}',
            '!src/{hooks,components}/**/*.test.{js,jsx,ts,tsx}',
          ],
          environment: 'node',
          exclude: [
            'src/trpc/commands/snapshots/provider-cleanup.db.test.ts',
            'src/trpc/commands/misc-settings/anonymous-analytics.db.test.ts',
          ],
          // Keep DB-backed server tests below the local Postgres connection limit.
          maxWorkers: 4,
          globalSetup: './vitest.setup.server.ts',
          setupFiles: './vitest.setup.mocks.ts',
        },
      },
      {
        extends: true,
        test: {
          name: 'server-global-db-state',
          include: [
            'src/trpc/commands/snapshots/provider-cleanup.db.test.ts',
            'src/trpc/commands/misc-settings/anonymous-analytics.db.test.ts',
          ],
          environment: 'node',
          globalSetup: './vitest.setup.server.ts',
          setupFiles: './vitest.setup.mocks.ts',
          // Deployment-wide fixtures run after ordinary server/client suites.
          sequence: { groupOrder: 1 },
          fileParallelism: false,
          maxWorkers: 1,
        },
      },
      {
        extends: true,
        resolve: {
          alias: {
            // The node export disables registration effects, even in jsdom.
            'react-resizable-panels': resolve(
              __dirname,
              'node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.esm.js',
            ),
          },
        },
        test: {
          name: 'client',
          include: [
            'src/**/*.client.test.{js,jsx,ts,tsx}',
            'src/{hooks,components}/**/*.test.{js,jsx,ts,tsx}',
          ],
          environment: 'jsdom',
          // Keep the full client suite below the CI runner's Node heap limit.
          // The server project runs concurrently with its own four workers.
          maxWorkers: 4,
          setupFiles: './vitest.setup.client.ts',
        },
      },
    ],
  },
});
