import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  splitting: false,
  sourcemap: true,
  minify: process.env.NODE_ENV === 'production',
  keepNames: true,
  noExternal: [/.*/],
  banner: {
    js: `import { createRequire as __createRequire } from 'module';const require = __createRequire(import.meta.url);`,
  },
});
