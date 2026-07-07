import fs from 'node:fs';

import { execa } from 'execa';

import { WorkerReleaseService } from '../worker-release';

const expectedLocalBuildEnv = {
  SENTRY_AUTH_TOKEN: '',
  SENTRY_ORG: '',
  SENTRY_PROJECT: '',
};

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(),
  },
  existsSync: vi.fn(),
}));

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

describe('WorkerReleaseService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(execa).mockResolvedValue({
      exitCode: 0,
    } as Awaited<ReturnType<typeof execa>>);
  });

  it('builds the local worker release archive from the current checkout', async () => {
    await WorkerReleaseService.buildLocalDevRelease({
      rootDir: '/repo',
    });

    expect(execa).toHaveBeenCalledWith(
      './scripts/build-worker-release.sh',
      ['local-dev', '--output-dir', '/repo/releases'],
      { cwd: '/repo', env: expectedLocalBuildEnv },
    );
  });

  it('reuses an existing archive when skipIfArchiveExists is enabled', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    await expect(
      WorkerReleaseService.buildLocalDevRelease({
        rootDir: '/repo',
        skipIfArchiveExists: true,
      }),
    ).resolves.toBe('/repo/releases/worker-vlocal-dev.tar.gz');

    expect(execa).not.toHaveBeenCalled();
  });

  it('reuses an existing archive in ensureLocalDevReleaseCurrent', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    await expect(
      WorkerReleaseService.ensureLocalDevReleaseCurrent({
        rootDir: '/repo',
      }),
    ).resolves.toBe('/repo/releases/worker-vlocal-dev.tar.gz');

    expect(execa).not.toHaveBeenCalled();
  });

  it('masks task Sentry publish variables before invoking the local release script', async () => {
    const originalSentryAuthToken = process.env.SENTRY_AUTH_TOKEN;
    const originalSentryOrg = process.env.SENTRY_ORG;
    const originalSentryProject = process.env.SENTRY_PROJECT;

    process.env.SENTRY_AUTH_TOKEN = 'task-sentry-token';
    process.env.SENTRY_ORG = 'external-org';
    process.env.SENTRY_PROJECT = 'external-project';

    try {
      await WorkerReleaseService.buildLocalDevRelease({
        rootDir: '/repo',
      });

      expect(execa).toHaveBeenCalledWith(
        './scripts/build-worker-release.sh',
        expect.any(Array),
        expect.objectContaining({
          env: expectedLocalBuildEnv,
        }),
      );
    } finally {
      if (originalSentryAuthToken === undefined) {
        delete process.env.SENTRY_AUTH_TOKEN;
      } else {
        process.env.SENTRY_AUTH_TOKEN = originalSentryAuthToken;
      }

      if (originalSentryOrg === undefined) {
        delete process.env.SENTRY_ORG;
      } else {
        process.env.SENTRY_ORG = originalSentryOrg;
      }

      if (originalSentryProject === undefined) {
        delete process.env.SENTRY_PROJECT;
      } else {
        process.env.SENTRY_PROJECT = originalSentryProject;
      }
    }
  });
});
