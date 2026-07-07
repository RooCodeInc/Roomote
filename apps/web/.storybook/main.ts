import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';

import type { StorybookConfig } from '@storybook/nextjs-vite';

const require = createRequire(import.meta.url);

const storybookDir = dirname(fileURLToPath(import.meta.url));

const mockHistoricalSandboxProvider = join(
  storybookDir,
  'mocks',
  'HistoricalSandboxProvider.tsx',
);

/**
 * This function is used to resolve the absolute path of a package.
 * It is needed in projects that use Yarn PnP or are set up within a monorepo.
 */
function getAbsolutePath(value: string): string {
  return dirname(require.resolve(join(value, 'package.json')));
}

/**
 * Vite plugin that replaces 'use server' files with no-op stubs.
 *
 * Server actions import heavy Node-only dependencies (database drivers,
 * ClickHouse, Redis, etc.) that cannot be bundled for the browser. This
 * plugin uses the `load` hook (runs before `transform`) to intercept files
 * containing 'use server' and replace their exports with async no-op
 * functions, mirroring how Next.js transforms server actions into client
 * references.
 */
function mockServerActions() {
  return {
    name: 'storybook-mock-server-actions',
    enforce: 'pre' as const,
    resolveId(_id: string, _importer?: string) {
      // Intercept analytics imports at resolution time - most reliable approach
      // Handle multiple path patterns: @/, ./, and /src/
      return null;
    },
    load(id: string) {
      const cleanId = id.split('?')[0];

      // Skip node_modules and non-JS/TS files
      if (cleanId.includes('node_modules')) return;
      if (!cleanId.match(/\.[tj]sx?$/)) return;

      let code: string;

      try {
        code = readFileSync(cleanId, 'utf-8');
      } catch {
        return;
      }

      const trimmed = code.trimStart();
      if (
        !trimmed.startsWith("'use server'") &&
        !trimmed.startsWith('"use server"')
      )
        return;

      // Extract named exports from all patterns:
      //   export const name, export function name, export async function name
      //   export { name1, name2, ... }
      const namedExports: string[] = [];
      const declPattern = /export\s+(?:async\s+)?(?:function|const)\s+(\w+)/g;
      let match;
      while ((match = declPattern.exec(code)) !== null) {
        namedExports.push(match[1]);
      }
      // Handle grouped exports: export { a, b, c };
      const groupPattern = /export\s*\{([^}]+)\}/g;
      while ((match = groupPattern.exec(code)) !== null) {
        const names = match[1].split(',').map((s) => s.trim());
        for (const name of names) {
          // Handle "localName as exportedName" syntax
          const parts = name.split(/\s+as\s+/);
          const exported = (parts[1] || parts[0]).trim();
          if (exported && /^\w+$/.test(exported)) {
            namedExports.push(exported);
          }
        }
      }

      // Preserve type/interface exports for TypeScript compatibility
      const typeExports: string[] = [];
      const typePattern = /export\s+(?:type|interface)\s+(\w+)[\s<{=]/g;
      while ((match = typePattern.exec(code)) !== null) {
        typeExports.push(match[1]);
      }

      const stubs = namedExports
        .map(
          (name) =>
            `export const ${name} = async (..._args) => { throw new Error('[Storybook] Server action "${name}" is not available in Storybook.'); };`,
        )
        .join('\n');

      // Re-export type declarations as-is so type-only imports still work
      const types = typeExports
        .map((name) => `export type ${name} = Record<string, never>;`)
        .join('\n');

      return `${stubs}\n${types}`;
    },
  };
}

const config: StorybookConfig = {
  stories: ['../src/**/*.mdx', '../src/**/*.stories.@(js|jsx|mjs|ts|tsx)'],
  addons: [
    getAbsolutePath('@storybook/addon-docs'),
    getAbsolutePath('@storybook/addon-a11y'),
    getAbsolutePath('@storybook/addon-themes'),
  ],
  framework: {
    name: getAbsolutePath('@storybook/nextjs-vite'),
    options: {},
  },
  staticDirs: ['../public'],
  viteFinal: async (config) => {
    // Allow any hostname so Storybook works behind the preview-proxy where the
    // Host header is a dynamic subdomain (e.g. *-storybook.preview.roomote.run).
    // Without this, Vite's host-check middleware returns 403 for every JS module
    // request, breaking the iframe while the HTML shell still loads.
    config.server = config.server || {};
    config.server.allowedHosts = true;

    // unicorn-magic splits exports: "node" condition → node.js (toPath,
    // traversePathUp), "default" → default.js (only delay). npm-run-path
    // (via execa) needs the Node exports. Adding "node" to resolve.conditions
    // ensures both Vite and the Chromatic addon's esbuild resolve the correct
    // entry point.
    config.resolve = config.resolve || {};
    config.resolve.conditions = ['node', ...(config.resolve.conditions || [])];

    const existingAliases = Array.isArray(config.resolve.alias)
      ? config.resolve.alias
      : config.resolve.alias && typeof config.resolve.alias === 'object'
        ? Object.entries(config.resolve.alias).map(([find, replacement]) => ({
            find,
            replacement,
          }))
        : [];
    config.resolve.alias = [
      ...existingAliases,
      {
        find: '@/app/(sandbox)/sandbox/[id]/hooks/HistoricalSandboxProvider',
        replacement: mockHistoricalSandboxProvider,
      },
    ];

    // Replace 'use server' files with no-op stubs so server-only dependencies
    // (ClickHouse, Postgres, Redis, etc.) are never pulled into the bundle.
    // Prepend to ensure it runs before any framework plugins.
    config.plugins = [mockServerActions(), ...(config.plugins || [])];

    return config;
  },
};

export default config;
