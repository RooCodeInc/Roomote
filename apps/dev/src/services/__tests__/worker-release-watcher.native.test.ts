import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { WorkerReleaseWatcherService } from '../worker-release-watcher';

describe('worker release watcher startup with native filesystem events', () => {
  let rootDir: string;
  let watcher: WorkerReleaseWatcherService;
  let startup: Promise<void> | undefined;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-watch-startup-'));
    await fs.mkdir(path.join(rootDir, 'apps/worker/src'), { recursive: true });
    await fs.mkdir(path.join(rootDir, 'scripts'));
    await fs.mkdir(path.join(rootDir, 'releases'));
    await fs.writeFile(
      path.join(rootDir, 'apps/worker/src/revision.ts'),
      'old',
    );
    // Keep the real build service, child process and filesystem watches. Only
    // compilation is replaced: snapshot source, hold the first build, publish.
    await fs.writeFile(
      path.join(rootDir, 'scripts/build-worker-release.sh'),
      `#!/bin/sh
set -eu
echo build >> builds
revision=$(cat apps/worker/src/revision.ts)
if [ ! -f first-build-started ]; then
  touch first-build-started
  while [ ! -f release-first-build ]; do sleep 0.02; done
fi
if [ -f fail-build ]; then exit 1; fi
printf '%s' "$revision" > releases/worker-vlocal-dev.tar.gz
`,
      { mode: 0o755 },
    );
    watcher = new WorkerReleaseWatcherService(rootDir);
    startup = undefined;
  });

  afterEach(async () => {
    watcher.stop();
    await fs.writeFile(path.join(rootDir, 'release-first-build'), '');
    await startup?.catch(() => undefined);
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it('rebuilds an edit made after the initial build read its source', async () => {
    startup = watcher.start();
    await vi.waitFor(
      async () => {
        await fs.access(path.join(rootDir, 'first-build-started'));
      },
      { timeout: 5_000 },
    );

    await fs.writeFile(
      path.join(rootDir, 'apps/worker/src/revision.ts'),
      'new',
    );
    // Let the actual debounce elapse while the initial build is still held.
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    await fs.writeFile(path.join(rootDir, 'release-first-build'), '');
    await startup;

    await vi.waitFor(
      async () => {
        expect(
          await fs.readFile(
            path.join(rootDir, 'releases/worker-vlocal-dev.tar.gz'),
            'utf8',
          ),
        ).toBe('new');
      },
      { timeout: 5_000 },
    );
  }, 15_000);

  it('closes startup watches and discards queued edits when the first build fails', async () => {
    await fs.writeFile(path.join(rootDir, 'fail-build'), '');
    startup = watcher.start();
    const rejected = expect(startup).rejects.toThrow();
    await vi.waitFor(
      async () => {
        await fs.access(path.join(rootDir, 'first-build-started'));
      },
      { timeout: 5_000 },
    );
    await fs.writeFile(
      path.join(rootDir, 'apps/worker/src/revision.ts'),
      'new',
    );
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    await fs.writeFile(path.join(rootDir, 'release-first-build'), '');
    await rejected;

    await fs.rm(path.join(rootDir, 'fail-build'));
    await fs.writeFile(
      path.join(rootDir, 'apps/worker/src/revision.ts'),
      'later',
    );
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    expect(await fs.readFile(path.join(rootDir, 'builds'), 'utf8')).toBe(
      'build\n',
    );
    await expect(
      fs.access(path.join(rootDir, 'releases/worker-vlocal-dev.tar.gz')),
    ).rejects.toThrow();
  }, 15_000);
});
