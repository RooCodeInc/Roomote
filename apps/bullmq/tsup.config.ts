import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { defineConfig } from 'tsup';

const nodeRequire = createRequire(import.meta.url);
const jsdomEntry = nodeRequire.resolve('jsdom');
const jsdomSyncWorkerEntry = join(
  dirname(jsdomEntry),
  'jsdom/living/xhr/xhr-sync-worker.js',
);

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    // JSDOM resolves this helper relative to the bundle at runtime.
    'xhr-sync-worker': jsdomSyncWorkerEntry,
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  splitting: false,
  // Minify production bundles so shipped images don't contain readable source.
  // keepNames preserves function/class names for error handling and logging.
  minify: process.env.NODE_ENV === 'production',
  keepNames: true,
  // Bundle everything including CJS packages.
  noExternal: [/.*/],
  banner: {
    // Add CJS require support for bundled CJS packages.
    js: `import { createRequire as __createRequire } from 'module';const require = __createRequire(import.meta.url);`,
  },
});
