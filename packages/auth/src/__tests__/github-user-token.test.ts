const mocks = vi.hoisted(() => ({
  decrypt: vi.fn((value: string) => value),
  findFirst: vi.fn(),
  resolveDeploymentEnvVar: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@roomote/db/encryption', () => ({
  decrypt: mocks.decrypt,
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...conditions: unknown[]) => ({ conditions })),
  db: {
    query: {
      githubUserMappings: { findFirst: mocks.findFirst },
    },
    update: mocks.update,
  },
  desc: vi.fn((value: unknown) => ({ desc: value })),
  eq: vi.fn((left: unknown, right: unknown) => ({ left, right })),
  githubUserMappings: {
    id: 'githubUserMappings.id',
    tokenRefreshClaim: 'githubUserMappings.tokenRefreshClaim',
    tokenRefreshClaimedAt: 'githubUserMappings.tokenRefreshClaimedAt',
    updatedAt: 'githubUserMappings.updatedAt',
    userId: 'githubUserMappings.userId',
  },
  isNull: vi.fn((value: unknown) => ({ isNull: value })),
  lt: vi.fn((left: unknown, right: unknown) => ({ left, right })),
  or: vi.fn((...conditions: unknown[]) => ({ or: conditions })),
  resolveDeploymentEnvVar: mocks.resolveDeploymentEnvVar,
}));

import {
  GitHubUserTokenError,
  resolveGitHubUserAccessToken,
} from '../github-user-token';

describe('resolveGitHubUserAccessToken', () => {
  const now = Date.parse('2026-09-16T12:00:00Z');
  const returning = vi.fn().mockResolvedValue([{ id: 'mapping-1' }]);
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.decrypt.mockImplementation((value: string) => value);
    mocks.update.mockReturnValue({ set });
    returning.mockResolvedValue([{ id: 'mapping-1' }]);
    mocks.resolveDeploymentEnvVar.mockImplementation(async (name: string) =>
      name === 'R_GITHUB_CLIENT_ID' ? 'client-id' : 'client-secret',
    );
  });

  it('returns null when the actor has no linked GitHub account', async () => {
    mocks.findFirst.mockResolvedValue(null);

    await expect(
      resolveGitHubUserAccessToken('actor-1', { now }),
    ).resolves.toBeNull();
    expect(mocks.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { left: 'githubUserMappings.userId', right: 'actor-1' },
      }),
    );
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('decrypts and returns the latest actor-owned token while it is valid', async () => {
    mocks.decrypt.mockImplementation((value: string) =>
      value === 'encrypted-actor-token' ? 'actor-token' : value,
    );
    mocks.findFirst.mockResolvedValue({
      id: 'mapping-1',
      accessToken: 'encrypted-actor-token',
      refreshToken: 'encrypted-refresh-token',
      tokenExpiresAt: new Date(now + 60 * 60 * 1000),
    });

    await expect(
      resolveGitHubUserAccessToken('actor-1', { now }),
    ).resolves.toBe('actor-token');
    expect(mocks.decrypt).toHaveBeenCalledWith('encrypted-actor-token');
    expect(mocks.decrypt).toHaveBeenCalledTimes(1);
    expect(mocks.resolveDeploymentEnvVar).not.toHaveBeenCalled();
  });

  it('refreshes an expiring token and persists rotated credentials for only that actor mapping', async () => {
    mocks.decrypt.mockImplementation((value: string) => {
      if (value === 'encrypted-expiring-token') return 'expiring-token';
      if (value === 'encrypted-refresh-token') return 'refresh-token';
      return value;
    });
    mocks.findFirst.mockResolvedValue({
      id: 'mapping-1',
      accessToken: 'encrypted-expiring-token',
      refreshToken: 'encrypted-refresh-token',
      tokenExpiresAt: new Date(now + 60_000),
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        access_token: 'refreshed-token',
        refresh_token: 'rotated-refresh-token',
        expires_in: 28_800,
      }),
    );

    await expect(
      resolveGitHubUserAccessToken('actor-1', { fetchImpl, now }),
    ).resolves.toBe('refreshed-token');
    const init = fetchImpl.mock.calls[0]![1]!;
    expect(init.redirect).toBe('error');
    const body = new URLSearchParams(String(init.body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh-token');
    expect(mocks.decrypt).toHaveBeenCalledWith('encrypted-expiring-token');
    expect(mocks.decrypt).toHaveBeenCalledWith('encrypted-refresh-token');
    expect(set).toHaveBeenCalledWith({
      accessToken: 'refreshed-token',
      refreshToken: 'rotated-refresh-token',
      tokenExpiresAt: new Date(now + 28_800_000),
      tokenRefreshClaim: null,
      tokenRefreshClaimedAt: null,
      updatedAt: new Date(now),
    });
    expect(where).toHaveBeenCalledWith(
      expect.objectContaining({
        conditions: expect.arrayContaining([
          { left: 'githubUserMappings.id', right: 'mapping-1' },
          { left: 'githubUserMappings.userId', right: 'actor-1' },
        ]),
      }),
    );
  });

  it('requires reconnection when an expired token cannot be refreshed', async () => {
    mocks.findFirst.mockResolvedValue({
      id: 'mapping-1',
      accessToken: 'expired-token',
      refreshToken: null,
      tokenExpiresAt: new Date(now - 1),
    });

    await expect(
      resolveGitHubUserAccessToken('actor-1', { now }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<GitHubUserTokenError>>({
        reauthorizationRequired: true,
        message: expect.stringContaining('Settings > Linked Accounts'),
      }),
    );
  });

  it('does not replace the saved token after a transient refresh failure', async () => {
    mocks.findFirst.mockResolvedValue({
      id: 'mapping-1',
      accessToken: 'expired-token',
      refreshToken: 'refresh-token',
      tokenExpiresAt: new Date(now - 1),
    });

    await expect(
      resolveGitHubUserAccessToken('actor-1', {
        now,
        fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error('down')),
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<GitHubUserTokenError>>({
        reauthorizationRequired: false,
        message: expect.stringContaining('Try again'),
      }),
    );
    expect(set).not.toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: expect.anything() }),
    );
  });

  it.each([
    [401, true, 'Reconnect GitHub'],
    [503, false, 'Try again'],
  ] as const)(
    'classifies a %s refresh response without replacing credentials',
    async (status, reauthorizationRequired, guidance) => {
      mocks.findFirst.mockResolvedValue({
        id: 'mapping-1',
        accessToken: 'expired-token',
        refreshToken: 'refresh-token',
        tokenExpiresAt: new Date(now - 1),
      });

      await expect(
        resolveGitHubUserAccessToken('actor-1', {
          now,
          fetchImpl: vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response(null, { status })),
        }),
      ).rejects.toEqual(
        expect.objectContaining<Partial<GitHubUserTokenError>>({
          reauthorizationRequired,
          message: expect.stringContaining(guidance),
        }),
      );
      expect(set).not.toHaveBeenCalledWith(
        expect.objectContaining({ accessToken: expect.anything() }),
      );
    },
  );

  it('single-flights concurrent refreshes without holding a database operation during OAuth', async () => {
    let activeDatabaseOperations = 0;
    let maxActiveDatabaseOperations = 0;
    const trackDatabaseOperation = async <T>(result: T): Promise<T> => {
      activeDatabaseOperations += 1;
      maxActiveDatabaseOperations = Math.max(
        maxActiveDatabaseOperations,
        activeDatabaseOperations,
      );
      await Promise.resolve();
      activeDatabaseOperations -= 1;
      return result;
    };

    mocks.findFirst.mockImplementation(() =>
      trackDatabaseOperation({
        id: 'mapping-1',
        accessToken: 'expired-token',
        refreshToken: 'refresh-token',
        tokenExpiresAt: new Date(now - 1),
      }),
    );
    returning.mockImplementation(() =>
      trackDatabaseOperation([{ id: 'mapping-1' }]),
    );

    let releaseOAuth!: (response: Response) => void;
    const oauthResponse = new Promise<Response>((resolve) => {
      releaseOAuth = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>(() => oauthResponse);

    const resolutions = Array.from({ length: 10 }, () =>
      resolveGitHubUserAccessToken('actor-1', { fetchImpl, now }),
    );
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

    expect(activeDatabaseOperations).toBe(0);
    expect(maxActiveDatabaseOperations).toBe(1);
    releaseOAuth(
      Response.json({
        access_token: 'refreshed-token',
        refresh_token: 'rotated-refresh-token',
        expires_in: 28_800,
      }),
    );

    await expect(Promise.all(resolutions)).resolves.toEqual(
      Array(10).fill('refreshed-token'),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(mocks.findFirst).toHaveBeenCalledTimes(1);
  });

  it('re-reads a token refreshed by another process after losing the claim', async () => {
    mocks.findFirst
      .mockResolvedValueOnce({
        id: 'mapping-1',
        accessToken: 'expired-token',
        refreshToken: 'refresh-token',
        tokenExpiresAt: new Date(now - 1),
      })
      .mockResolvedValueOnce({
        id: 'mapping-1',
        accessToken: 'refreshed-by-peer',
        refreshToken: 'rotated-by-peer',
        tokenExpiresAt: new Date(now + 28_800_000),
      });
    returning.mockResolvedValueOnce([]);
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      resolveGitHubUserAccessToken('actor-1', { fetchImpl, now }),
    ).resolves.toBe('refreshed-by-peer');

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mocks.findFirst).toHaveBeenCalledTimes(2);
  });

  it('does not return a refresh result after the linked account changes', async () => {
    mocks.findFirst
      .mockResolvedValueOnce({
        id: 'mapping-1',
        accessToken: 'expired-token',
        refreshToken: 'refresh-token',
        tokenExpiresAt: new Date(now - 1),
        updatedAt: new Date(now - 60_000),
      })
      .mockResolvedValueOnce({
        id: 'mapping-1',
        accessToken: 'relinked-token',
        refreshToken: 'relinked-refresh-token',
        tokenExpiresAt: new Date(now + 28_800_000),
        updatedAt: new Date(now),
      });
    returning
      .mockResolvedValueOnce([{ id: 'mapping-1' }])
      .mockResolvedValueOnce([]);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        access_token: 'stale-refresh-result',
        refresh_token: 'stale-rotated-refresh-token',
        expires_in: 28_800,
      }),
    );

    await expect(
      resolveGitHubUserAccessToken('actor-1', { fetchImpl, now }),
    ).resolves.toBe('relinked-token');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(mocks.findFirst).toHaveBeenCalledTimes(2);
  });
});
