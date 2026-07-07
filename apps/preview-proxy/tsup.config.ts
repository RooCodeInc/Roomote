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
  // Bundle everything including workspace packages with TypeScript source.
  noExternal: [/.*/],
  banner: {
    // Add CJS require support for bundled CJS packages.
    js: `import { createRequire as __createRequire } from 'module';const require = __createRequire(import.meta.url);`,
  },
  esbuildOptions(options) {
    // pino's thread-stream spawns a worker thread from a file resolved via
    // __dirname, which is unavailable in ESM bundles.  Keep pino and its
    // transport dependencies external so they load from node_modules as CJS.
    options.external = [
      ...(options.external ?? []),
      'pino',
      'pino-pretty',
      'pino-http',
      'thread-stream',
    ];
  },
});
