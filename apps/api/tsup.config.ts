import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
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
  esbuildOptions(options) {
    // Keep runtime-only dependency trees out of the API bundle.
    // tsup-level `external` is ignored when `noExternal: [/.*/]` is enabled,
    // so this must be applied at the esbuild layer.
    options.external = [
      ...(options.external ?? []),
      'dompurify',
      'jsdom',
      'snowflake-sdk',
    ];
  },
});
