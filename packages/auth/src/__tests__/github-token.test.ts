const {
  mockCreateInstallationAccessToken,
  mockEnv,
  mockFindActiveInstallations,
  mockFindInstallation,
  mockJwtSign,
  mockOctokit,
  mockResolveDeploymentEnvVar,
} = vi.hoisted(() => {
  const mockCreateInstallationAccessToken = vi.fn();
  const mockOctokit = vi.fn(function (
    this: {
      options: unknown;
      rest: {
        apps: {
          createInstallationAccessToken: typeof mockCreateInstallationAccessToken;
        };
      };
    },
    options: unknown,
  ) {
    this.options = options;
    this.rest = {
      apps: {
        createInstallationAccessToken: mockCreateInstallationAccessToken,
      },
    };
  });

  return {
    mockCreateInstallationAccessToken,
    mockEnv: {
      NODE_ENV: 'development',
      R_GITHUB_APP_ID: 'default-app-id' as string | undefined,
      R_GITHUB_APP_PRIVATE_KEY: 'default-private-key' as string | undefined,
    },
    mockFindActiveInstallations: vi.fn(),
    mockFindInstallation: vi.fn(),
    mockJwtSign: vi.fn(),
    mockOctokit,
    mockResolveDeploymentEnvVar: vi.fn(),
  };
});

vi.mock('@octokit/rest', () => ({
  Octokit: mockOctokit,
}));

vi.mock('jsonwebtoken', () => ({
  default: {
    sign: (...args: unknown[]) => mockJwtSign(...args),
  },
}));

vi.mock('@roomote/env', () => ({
  Env: mockEnv,
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...conditions: unknown[]) => ({ type: 'and', conditions })),
  db: {
    query: {
      githubInstallations: {
        findMany: (...args: unknown[]) => mockFindActiveInstallations(...args),
        findFirst: (...args: unknown[]) => mockFindInstallation(...args),
      },
    },
  },
  desc: vi.fn((value: unknown) => ({ type: 'desc', value })),
  eq: vi.fn((left: unknown, right: unknown) => ({ type: 'eq', left, right })),
  githubInstallations: {
    createdAt: 'githubInstallations.createdAt',
    suspendedAt: 'githubInstallations.suspendedAt',
  },
  isNull: vi.fn((value: unknown) => ({ type: 'isNull', value })),
  orgs: {},
  resolveDeploymentEnvVar: (...args: unknown[]) =>
    mockResolveDeploymentEnvVar(...args),
  users: {},
}));

import {
  clearGitHubTokenCacheForTesting,
  createGitHubToken,
  createGitHubTokenWithMetadata,
  resolveGitHubAppCredentials,
  resolveRuntimeGitHubAppCredentials,
} from '../github-token';

describe('resolveGitHubAppCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.NODE_ENV = 'development';
    mockEnv.R_GITHUB_APP_ID = 'default-app-id';
    mockEnv.R_GITHUB_APP_PRIVATE_KEY = 'default-private-key';
  });

  it('preserves explicit GitHub App credentials', () => {
    expect(
      resolveGitHubAppCredentials({
        appId: 'explicit-app-id',
        privateKey: 'explicit-private-key',
      }),
    ).toEqual({
      appId: 'explicit-app-id',
      privateKey: 'explicit-private-key',
    });
  });

  it('falls back to default GitHub App credentials outside development', () => {
    mockEnv.NODE_ENV = 'production';

    expect(resolveGitHubAppCredentials()).toEqual({
      appId: 'default-app-id',
      privateKey: 'default-private-key',
    });
  });
});

describe('resolveRuntimeGitHubAppCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.R_GITHUB_APP_ID = 'default-app-id';
    mockEnv.R_GITHUB_APP_PRIVATE_KEY = 'default-private-key';
    mockResolveDeploymentEnvVar.mockResolvedValue(null);
  });

  it('preserves explicit GitHub App credentials', async () => {
    await expect(
      resolveRuntimeGitHubAppCredentials({
        appId: 'explicit-app-id',
        privateKey: 'explicit-private-key',
      }),
    ).resolves.toEqual({
      appId: 'explicit-app-id',
      privateKey: 'explicit-private-key',
    });
    expect(mockResolveDeploymentEnvVar).not.toHaveBeenCalled();
  });

  it('resolves deployment env vars before falling back to Env', async () => {
    mockResolveDeploymentEnvVar.mockImplementation(async (name: string) =>
      name === 'R_GITHUB_APP_ID'
        ? 'db-app-id'
        : name === 'R_GITHUB_APP_PRIVATE_KEY'
          ? 'db-private-key'
          : null,
    );

    await expect(resolveRuntimeGitHubAppCredentials()).resolves.toEqual({
      appId: 'db-app-id',
      privateKey: 'db-private-key',
    });
  });

  it('falls back to Env credentials when deployment env vars are missing', async () => {
    await expect(resolveRuntimeGitHubAppCredentials()).resolves.toEqual({
      appId: 'default-app-id',
      privateKey: 'default-private-key',
    });
  });

  it('fails clearly when no GitHub App credentials are configured', async () => {
    mockEnv.R_GITHUB_APP_ID = '';
    mockEnv.R_GITHUB_APP_PRIVATE_KEY = '';

    await expect(resolveRuntimeGitHubAppCredentials()).rejects.toThrow(
      'GitHub App credentials are not configured.',
    );
  });

  it('fails clearly when GitHub App credentials are undefined at runtime', async () => {
    mockEnv.R_GITHUB_APP_ID = undefined;
    mockEnv.R_GITHUB_APP_PRIVATE_KEY = undefined;

    await expect(resolveRuntimeGitHubAppCredentials()).rejects.toThrow(
      'GitHub App credentials are not configured.',
    );
  });
});

describe('createGitHubToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearGitHubTokenCacheForTesting();
    mockEnv.R_GITHUB_APP_ID = '';
    mockEnv.R_GITHUB_APP_PRIVATE_KEY = '';
    mockFindActiveInstallations.mockResolvedValue([
      {
        installationId: 12345,
      },
    ]);
    mockCreateInstallationAccessToken.mockResolvedValue({
      data: {
        token: 'ghs_installation_token',
        expires_at: '2030-01-01T01:00:00.000Z',
      },
    });
    mockJwtSign.mockReturnValue('app-jwt');
    mockResolveDeploymentEnvVar.mockImplementation(async (name: string) =>
      name === 'R_GITHUB_APP_ID'
        ? 'db-app-id'
        : name === 'R_GITHUB_APP_PRIVATE_KEY'
          ? 'db-private-key'
          : null,
    );
  });

  it('uses deployment-backed GitHub App credentials when creating an installation token', async () => {
    await expect(
      createGitHubToken({ type: 'activeInstallation' }),
    ).resolves.toBe('ghs_installation_token');

    expect(mockJwtSign).toHaveBeenCalledWith(
      expect.objectContaining({ iss: 'db-app-id' }),
      'db-private-key',
      { algorithm: 'RS256' },
    );
    expect(mockOctokit).toHaveBeenCalledWith({
      auth: 'app-jwt',
      userAgent: 'Roomote',
    });
    expect(mockCreateInstallationAccessToken).toHaveBeenCalledWith({
      installation_id: 12345,
    });
  });

  it('scopes the installation token to the requested repository ids', async () => {
    mockFindInstallation.mockResolvedValue({ installationId: 999 });

    await expect(
      createGitHubToken({
        type: 'installationId',
        installationId: 'inst-row-id',
        repositoryIds: [7, 8],
      }),
    ).resolves.toBe('ghs_installation_token');

    expect(mockCreateInstallationAccessToken).toHaveBeenCalledWith({
      installation_id: 999,
      repository_ids: [7, 8],
    });
  });

  it('omits repository_ids when no repository ids are supplied', async () => {
    mockFindInstallation.mockResolvedValue({ installationId: 999 });

    await createGitHubToken({
      type: 'installationId',
      installationId: 'inst-row-id',
    });

    expect(mockCreateInstallationAccessToken).toHaveBeenCalledWith({
      installation_id: 999,
    });
  });

  it('caches a valid installation token and reports only the actual mint request', async () => {
    const onTokenMintRequest = vi.fn();

    await expect(
      createGitHubToken({ type: 'activeInstallation' }, undefined, {
        cache: true,
        onTokenMintRequest,
      }),
    ).resolves.toBe('ghs_installation_token');
    await expect(
      createGitHubToken({ type: 'activeInstallation' }, undefined, {
        cache: true,
        onTokenMintRequest,
      }),
    ).resolves.toBe('ghs_installation_token');

    expect(mockCreateInstallationAccessToken).toHaveBeenCalledTimes(1);
    expect(onTokenMintRequest).toHaveBeenCalledTimes(1);
  });

  it('normalizes equivalent repository scopes without crossing scope boundaries', async () => {
    mockFindInstallation.mockResolvedValue({ installationId: 999 });

    await createGitHubToken(
      {
        type: 'installationId',
        installationId: 'inst-row-id',
        repositoryIds: [8, 7, 8],
      },
      undefined,
      { cache: true },
    );
    await createGitHubToken(
      {
        type: 'installationId',
        installationId: 'inst-row-id',
        repositoryIds: [7, 8],
      },
      undefined,
      { cache: true },
    );
    await createGitHubToken(
      {
        type: 'installationId',
        installationId: 'inst-row-id',
        repositoryIds: [7],
      },
      undefined,
      { cache: true },
    );

    expect(mockCreateInstallationAccessToken).toHaveBeenCalledTimes(2);
    expect(mockCreateInstallationAccessToken).toHaveBeenNthCalledWith(1, {
      installation_id: 999,
      repository_ids: [7, 8],
    });
    expect(mockCreateInstallationAccessToken).toHaveBeenNthCalledWith(2, {
      installation_id: 999,
      repository_ids: [7],
    });
  });

  it('single-flights concurrent token requests for the same scope', async () => {
    let resolveMint:
      | ((value: { data: { token: string; expires_at: string } }) => void)
      | undefined;
    mockCreateInstallationAccessToken.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveMint = resolve;
      }),
    );

    const first = createGitHubToken({ type: 'activeInstallation' });
    const second = createGitHubToken({ type: 'activeInstallation' });

    await vi.waitFor(() => {
      expect(mockCreateInstallationAccessToken).toHaveBeenCalledTimes(1);
    });
    resolveMint?.({
      data: {
        token: 'ghs_shared_token',
        expires_at: '2030-01-01T01:00:00.000Z',
      },
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      'ghs_shared_token',
      'ghs_shared_token',
    ]);
    expect(mockCreateInstallationAccessToken).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a token inside the refresh buffer', async () => {
    mockCreateInstallationAccessToken.mockResolvedValue({
      data: {
        token: 'ghs_expiring_token',
        expires_at: new Date(Date.now() + 4 * 60 * 1000).toISOString(),
      },
    });

    await createGitHubToken({ type: 'activeInstallation' }, undefined, {
      cache: true,
    });
    await createGitHubToken({ type: 'activeInstallation' }, undefined, {
      cache: true,
    });

    expect(mockCreateInstallationAccessToken).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a token beyond the configured cache age', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T12:00:00.000Z'));
    mockCreateInstallationAccessToken.mockResolvedValue({
      data: {
        token: 'ghs_cached_token',
        expires_at: '2026-08-24T13:00:00.000Z',
      },
    });

    try {
      await createGitHubToken({ type: 'activeInstallation' }, undefined, {
        cache: true,
        maxCacheAgeMs: 15 * 60 * 1000,
      });
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
      await createGitHubToken({ type: 'activeInstallation' }, undefined, {
        cache: true,
        maxCacheAgeMs: 15 * 60 * 1000,
      });

      expect(mockCreateInstallationAccessToken).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('force-refreshes and replaces a cached token', async () => {
    mockCreateInstallationAccessToken
      .mockResolvedValueOnce({
        data: {
          token: 'ghs_first_token',
          expires_at: '2030-01-01T01:00:00.000Z',
        },
      })
      .mockResolvedValueOnce({
        data: {
          token: 'ghs_fresh_token',
          expires_at: '2030-01-01T01:00:00.000Z',
        },
      });

    await expect(
      createGitHubToken({ type: 'activeInstallation' }, undefined, {
        cache: true,
      }),
    ).resolves.toBe('ghs_first_token');
    await expect(
      createGitHubToken({ type: 'activeInstallation' }, undefined, {
        cache: true,
        forceRefresh: true,
      }),
    ).resolves.toBe('ghs_fresh_token');
    await expect(
      createGitHubToken({ type: 'activeInstallation' }, undefined, {
        cache: true,
      }),
    ).resolves.toBe('ghs_fresh_token');

    expect(mockCreateInstallationAccessToken).toHaveBeenCalledTimes(2);
  });

  it('returns the installation token expiry metadata', async () => {
    await expect(
      createGitHubTokenWithMetadata({ type: 'activeInstallation' }),
    ).resolves.toEqual({
      token: 'ghs_installation_token',
      expiresAt: new Date('2030-01-01T01:00:00.000Z'),
    });
  });
});
