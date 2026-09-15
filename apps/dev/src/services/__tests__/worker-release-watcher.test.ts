import fs from 'node:fs';

import { WorkerReleaseService } from '../worker-release';
import {
  WorkerReleaseWatcherService,
  versionFromWorkerReleasePath,
} from '../worker-release-watcher';

vi.mock('../worker-release', () => ({
  WorkerReleaseService: {
    buildLocalDevRelease: vi.fn(),
  },
}));

describe('versionFromWorkerReleasePath', () => {
  it('returns local-dev when no path is given', () => {
    expect(versionFromWorkerReleasePath()).toBe('local-dev');
    expect(versionFromWorkerReleasePath(undefined)).toBe('local-dev');
  });

  it('returns local-dev for an empty string', () => {
    expect(versionFromWorkerReleasePath('')).toBe('local-dev');
  });

  it('extracts version from a simple filename', () => {
    expect(versionFromWorkerReleasePath('worker-vlocal-dev.tar.gz')).toBe(
      'local-dev',
    );
  });

  it('extracts version from an absolute path', () => {
    expect(
      versionFromWorkerReleasePath(
        '/sandbox/repos/Roomote/releases/worker-vnested-dev.tar.gz',
      ),
    ).toBe('nested-dev');
  });

  it('extracts semver versions', () => {
    expect(versionFromWorkerReleasePath('worker-v1.2.3.tar.gz')).toBe('1.2.3');
  });

  it('extracts semver with pre-release suffix', () => {
    expect(versionFromWorkerReleasePath('worker-v1.0.0-beta.1.tar.gz')).toBe(
      '1.0.0-beta.1',
    );
  });

  it('returns local-dev for non-matching filenames', () => {
    expect(versionFromWorkerReleasePath('/some/path/random.tar.gz')).toBe(
      'local-dev',
    );
    expect(versionFromWorkerReleasePath('not-a-release-archive.zip')).toBe(
      'local-dev',
    );
  });
});

describe('WorkerReleaseWatcherService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(WorkerReleaseService.buildLocalDevRelease).mockResolvedValue(
      '/repo/releases/worker-vlocal-dev.tar.gz',
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rebuilds the local worker archive with the shared local-dev version', async () => {
    const watcher = new WorkerReleaseWatcherService('/repo');

    await rebuild(watcher);

    expect(WorkerReleaseService.buildLocalDevRelease).toHaveBeenCalledWith({
      rootDir: '/repo',
      version: 'local-dev',
    });
  });

  it('waits for a successful initial build before reporting readiness', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let resolveBuild: ((archivePath: string) => void) | undefined;
    vi.mocked(WorkerReleaseService.buildLocalDevRelease).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveBuild = resolve;
        }),
    );
    const watcher = new WorkerReleaseWatcherService('/repo');

    const start = watcher.start();

    await vi.waitFor(() => {
      expect(WorkerReleaseService.buildLocalDevRelease).toHaveBeenCalledOnce();
    });
    expect(log).not.toHaveBeenCalledWith(
      '[worker-release-watcher] Ready -- waiting for file changes',
    );

    resolveBuild?.('/repo/releases/worker-vlocal-dev.tar.gz');
    await start;

    const messages = log.mock.calls.map(([message]) => message);
    expect(
      messages.indexOf(
        '[worker-release-watcher] Rebuilding worker release archive...',
      ),
    ).toBeLessThan(
      messages.indexOf(
        '[worker-release-watcher] Ready -- waiting for file changes',
      ),
    );
    watcher.stop();
  });

  it('reports readiness without rebuilding when the archive already exists', async () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((filePath) =>
      String(filePath).endsWith('worker-vlocal-dev.tar.gz'),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const watcher = new WorkerReleaseWatcherService('/repo');

    await watcher.start();

    expect(WorkerReleaseService.buildLocalDevRelease).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      '[worker-release-watcher] Ready -- waiting for file changes',
    );
    watcher.stop();
  });

  it('rejects startup without reporting readiness when the initial build fails', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(WorkerReleaseService.buildLocalDevRelease).mockRejectedValue(
      new Error('synthetic initial build failure'),
    );
    const watcher = new WorkerReleaseWatcherService('/repo');

    await expect(watcher.start()).rejects.toThrow(
      'synthetic initial build failure',
    );

    expect(log).not.toHaveBeenCalledWith(
      '[worker-release-watcher] Ready -- waiting for file changes',
    );
  });

  it('keeps later rebuild failures nonfatal', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(WorkerReleaseService.buildLocalDevRelease).mockRejectedValue(
      new Error('synthetic rebuild failure'),
    );
    const watcher = new WorkerReleaseWatcherService('/repo');

    await expect(rebuild(watcher)).resolves.toBeUndefined();
  });

  it('runs a queued rebuild after a nonfatal rebuild failure', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let rejectBuild: ((error: Error) => void) | undefined;
    vi.mocked(WorkerReleaseService.buildLocalDevRelease)
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectBuild = reject;
          }),
      )
      .mockResolvedValueOnce('/repo/releases/worker-vlocal-dev.tar.gz');
    const watcher = new WorkerReleaseWatcherService('/repo');

    const failedRebuild = rebuild(watcher);
    await vi.waitFor(() => {
      expect(WorkerReleaseService.buildLocalDevRelease).toHaveBeenCalledOnce();
    });
    await rebuild(watcher);
    rejectBuild?.(new Error('synthetic rebuild failure'));
    await failedRebuild;

    await vi.waitFor(() => {
      expect(WorkerReleaseService.buildLocalDevRelease).toHaveBeenCalledTimes(
        2,
      );
    });
  });
});

async function rebuild(watcher: WorkerReleaseWatcherService): Promise<void> {
  const rebuildFn = Reflect.get(watcher, 'rebuild') as
    | (() => Promise<void>)
    | undefined;

  if (!rebuildFn) {
    throw new Error('Expected watcher rebuild method');
  }

  await rebuildFn.call(watcher);
}
