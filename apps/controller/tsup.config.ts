import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/instrument.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  splitting: false,
  sourcemap: true,
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
