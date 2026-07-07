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
      GITHUB_APP_ID: 'default-app-id',
      GITHUB_APP_PRIVATE_KEY: 'default-private-key',
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
  createGitHubToken,
  resolveGitHubAppCredentials,
  resolveRuntimeGitHubAppCredentials,
} from '../github-token';

describe('resolveGitHubAppCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.NODE_ENV = 'development';
    mockEnv.GITHUB_APP_ID = 'default-app-id';
    mockEnv.GITHUB_APP_PRIVATE_KEY = 'default-private-key';
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
    mockEnv.GITHUB_APP_ID = 'default-app-id';
    mockEnv.GITHUB_APP_PRIVATE_KEY = 'default-private-key';
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
      name === 'GITHUB_APP_ID'
        ? 'db-app-id'
        : name === 'GITHUB_APP_PRIVATE_KEY'
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
    mockEnv.GITHUB_APP_ID = '';
    mockEnv.GITHUB_APP_PRIVATE_KEY = '';

    await expect(resolveRuntimeGitHubAppCredentials()).rejects.toThrow(
      'GitHub App credentials are not configured.',
    );
  });
});

describe('createGitHubToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.GITHUB_APP_ID = '';
    mockEnv.GITHUB_APP_PRIVATE_KEY = '';
    mockFindActiveInstallations.mockResolvedValue([
      {
        installationId: 12345,
      },
    ]);
    mockCreateInstallationAccessToken.mockResolvedValue({
      data: { token: 'ghs_installation_token' },
    });
    mockJwtSign.mockReturnValue('app-jwt');
    mockResolveDeploymentEnvVar.mockImplementation(async (name: string) =>
      name === 'GITHUB_APP_ID'
        ? 'db-app-id'
        : name === 'GITHUB_APP_PRIVATE_KEY'
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
});
