vi.mock('jsonwebtoken', () => ({
  default: {
    sign: vi.fn(() => 'github-app-jwt'),
  },
}));

import {
  clearWorkerReleaseGitHubAuthCache,
  getWorkerReleaseGitHubToken,
} from '../worker-release-github-auth';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('getWorkerReleaseGitHubToken', () => {
  beforeEach(() => {
    clearWorkerReleaseGitHubAuthCache();
    mockFetch.mockReset();
  });

  it('mints and caches a repo-scoped contents-read installation token', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 123456 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: 'ghs_worker_release',
          expires_at: '2030-01-01T00:00:00Z',
        }),
      });

    await expect(getWorkerReleaseGitHubToken()).resolves.toBe(
      'ghs_worker_release',
    );
    await expect(getWorkerReleaseGitHubToken()).resolves.toBe(
      'ghs_worker_release',
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/repos/Roomote/Roomote/installation',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: expect.stringMatching(/^Bearer /),
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        }),
      }),
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/app/installations/123456/access_tokens',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: expect.stringMatching(/^Bearer /),
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        }),
        body: JSON.stringify({
          repositories: ['Roomote'],
          permissions: { contents: 'read' },
        }),
      }),
    );
  });

  it('deduplicates concurrent token minting', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 123456 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: 'ghs_worker_release',
          expires_at: '2030-01-01T00:00:00Z',
        }),
      });

    const [a, b] = await Promise.all([
      getWorkerReleaseGitHubToken(),
      getWorkerReleaseGitHubToken(),
    ]);

    expect(a).toBe('ghs_worker_release');
    expect(b).toBe('ghs_worker_release');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws when the Roomote installation lookup fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    await expect(getWorkerReleaseGitHubToken()).rejects.toThrow(
      'Failed to resolve GitHub App installation for Roomote/Roomote: 404 Not Found',
    );
  });
});
