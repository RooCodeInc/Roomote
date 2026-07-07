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

  it('rebuilds the local worker archive with the shared local-dev version', async () => {
    const watcher = new WorkerReleaseWatcherService('/repo');

    await rebuild(watcher);

    expect(WorkerReleaseService.buildLocalDevRelease).toHaveBeenCalledWith({
      rootDir: '/repo',
      version: 'local-dev',
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
