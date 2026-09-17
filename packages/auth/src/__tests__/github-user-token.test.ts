const mocks = vi.hoisted(() => ({
  decrypt: vi.fn((value: string) => value),
  execute: vi.fn(),
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
    transaction: async (callback: (tx: unknown) => unknown) =>
      callback({
        execute: mocks.execute,
        query: {
          githubUserMappings: { findFirst: mocks.findFirst },
        },
        update: mocks.update,
      }),
  },
  desc: vi.fn((value: unknown) => ({ desc: value })),
  eq: vi.fn((left: unknown, right: unknown) => ({ left, right })),
  githubUserMappings: {
    id: 'githubUserMappings.id',
    updatedAt: 'githubUserMappings.updatedAt',
    userId: 'githubUserMappings.userId',
  },
  resolveDeploymentEnvVar: mocks.resolveDeploymentEnvVar,
  sql: vi.fn(),
}));

import {
  GitHubUserTokenError,
  resolveGitHubUserAccessToken,
} from '../github-user-token';

describe('resolveGitHubUserAccessToken', () => {
  const now = Date.parse('2026-09-16T12:00:00Z');
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn(() => ({ where }));

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.decrypt.mockImplementation((value: string) => value);
    mocks.execute.mockResolvedValue(undefined);
    mocks.update.mockReturnValue({ set });
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
      updatedAt: new Date(now),
    });
    expect(where).toHaveBeenCalledWith({
      conditions: [
        { left: 'githubUserMappings.id', right: 'mapping-1' },
        { left: 'githubUserMappings.userId', right: 'actor-1' },
      ],
    });
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
    expect(mocks.update).not.toHaveBeenCalled();
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
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );
});
