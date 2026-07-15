import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    worker: 'scripts/worker.ts',
    'mcp/roomote-mcp-server/index': 'src/mcp/roomote-mcp-server/index.ts',
  },
  format: ['esm'],
  dts: false,
  splitting: false,
  sourcemap: true,
  // Minify production bundles so shipped release archives don't contain
  // readable source. keepNames preserves function/class names for error
  // handling and logging.
  minify: process.env.NODE_ENV === 'production',
  keepNames: true,
  clean: true,
  outDir: 'dist',
  // Bundle everything including CJS packages.
  noExternal: [/.*/],
  platform: 'node',
  banner: {
    // Add CJS require support for bundled CJS packages.
    js: `import { createRequire as __createRequire } from 'module';const require = __createRequire(import.meta.url);`,
  },
  esbuildOptions(options) {
    // Exclude native modules that cannot be bundled into a single JS file.
    // This must be set at the esbuild level because tsup's noExternal: [/.*/]
    // overrides tsup-level external for matching packages.
    options.external = [...(options.external ?? []), 'node-pty'];
  },
});
