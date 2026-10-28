import { generateKeyPairSync } from 'node:crypto';

const { findRepositories, resolveEnvVar } = vi.hoisted(() => ({
  findRepositories: vi.fn(),
  resolveEnvVar: vi.fn(),
}));

vi.mock('@roomote/db/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/db/server')>()),
  db: { query: { repositories: { findMany: findRepositories } } },
  resolveDeploymentEnvVar: resolveEnvVar,
}));

import {
  getPullRequestsForAnalytics,
  getUpdatedPullRequestsForAnalytics,
} from '../api';

const readers = [
  getPullRequestsForAnalytics,
  getUpdatedPullRequestsForAnalytics,
];
const installation = { id: 'installation-a', installationId: 42 };
const repository = {
  id: 'repo-a',
  fullName: 'fixture/recovery',
  githubInstallation: installation,
};
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

describe('GitHub analytics repository access', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    findRepositories.mockResolvedValue([repository]);
    resolveEnvVar.mockResolvedValue(null);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('No external requests allowed')),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  function allowClient() {
    resolveEnvVar.mockImplementation(async (name: string) =>
      name === 'R_GITHUB_APP_ID' ? '12345' : privateKey,
    );
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(input instanceof Request ? input.url : String(input))
        .pathname;
      return Response.json(
        path.endsWith('/access_tokens')
          ? { token: 'fixture-token', expires_at: '2099-01-01T00:00:00Z' }
          : [],
      );
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  }

  it.each(readers)(
    'does not turn missing authenticated clients into an empty history: %s',
    async (read) => {
      await expect(
        read({ userId: 'user-a', repositoryIds: ['repo-a'] }),
      ).rejects.toThrow('Unable to access all requested GitHub repositories');
    },
  );

  it.each(readers)(
    'rejects repositories without an installation: %s',
    async (read) => {
      findRepositories.mockResolvedValue([
        { ...repository, githubInstallation: null },
      ]);
      await expect(
        read({ userId: 'user-a', repositoryIds: ['repo-a'] }),
      ).rejects.toThrow('Unable to access all requested GitHub repositories');
    },
  );

  it.each(readers)(
    'accepts an actually empty history once access recovers: %s',
    async (read) => {
      await expect(
        read({ userId: 'user-a', repositoryIds: ['repo-a'] }),
      ).rejects.toThrow();
      allowClient();
      await expect(
        read({ userId: 'user-a', repositoryIds: ['repo-a'] }),
      ).resolves.toEqual([]);
    },
  );

  it('does not return a partial history when only some requested repositories are accessible', async () => {
    findRepositories.mockResolvedValue([
      repository,
      { ...repository, id: 'repo-b', githubInstallation: null },
    ]);
    const fetch = allowClient();
    await expect(
      getPullRequestsForAnalytics({
        userId: 'user-a',
        repositoryIds: ['repo-a', 'repo-b'],
      }),
    ).rejects.toThrow();
    expect(
      fetch.mock.calls.every(([input]) =>
        String(input).includes('/access_tokens'),
      ),
    ).toBe(true);
  });

  it('retains an empty requested repository set as a no-op', async () => {
    findRepositories.mockResolvedValue([]);
    for (const read of readers) {
      await expect(
        read({ userId: 'user-a', repositoryIds: [] }),
      ).resolves.toEqual([]);
    }
  });
});
