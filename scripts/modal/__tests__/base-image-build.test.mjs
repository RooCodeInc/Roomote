import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const scripts = [
  'scripts/modal/build-base-image.sh',
  'scripts/modal/build-and-push-base-image.sh',
];

for (const script of scripts) {
  test(`${script} passes the worker product version to Docker`, async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'roomote-modal-build-test-'));
    const dockerArgsPath = join(tempDir, 'docker-args.txt');
    const dockerPath = join(tempDir, 'docker');

    try {
      await writeFile(
        dockerPath,
        `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.ROOMOTE_DOCKER_ARGS_PATH, process.argv.slice(2).join('\\n'));
`,
        { mode: 0o755 },
      );

      await execFileAsync(
        'bash',
        [join(repoRoot, script), 'ghcr.io/example/worker:test'],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            PATH: `${tempDir}:${process.env.PATH ?? ''}`,
            RELEASE_PRODUCT_VERSION: '9.8.7',
            ROOMOTE_DOCKER_ARGS_PATH: dockerArgsPath,
          },
        },
      );

      const args = (await readFile(dockerArgsPath, 'utf8')).split('\n');
      const buildArgIndex = args.indexOf('--build-arg');

      assert.notEqual(buildArgIndex, -1);
      assert.equal(args[buildArgIndex + 1], 'RELEASE_PRODUCT_VERSION=9.8.7');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
}
