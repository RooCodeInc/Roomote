import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const nodeRequire = createRequire(import.meta.url);

describe('BullMQ build artifact', () => {
  it('ships the JSDOM synchronous XHR worker beside the bundled entrypoint', () => {
    const packageDirectory = join(import.meta.dirname, '..');
    const outputDirectory = mkdtempSync(
      join(tmpdir(), 'roomote-bullmq-build-'),
    );

    try {
      execFileSync(
        process.execPath,
        [
          join(
            dirname(nodeRequire.resolve('tsup/package.json')),
            'dist/cli-default.js',
          ),
          '--config',
          join(packageDirectory, 'tsup.config.ts'),
          '--out-dir',
          outputDirectory,
        ],
        { cwd: packageDirectory, stdio: 'pipe' },
      );

      const bundlePath = join(outputDirectory, 'index.js');
      expect(readFileSync(bundlePath, 'utf8')).toContain(
        'require.resolve("./xhr-sync-worker.js")',
      );
      expect(createRequire(bundlePath).resolve('./xhr-sync-worker.js')).toBe(
        join(dirname(bundlePath), 'xhr-sync-worker.js'),
      );
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });
});
