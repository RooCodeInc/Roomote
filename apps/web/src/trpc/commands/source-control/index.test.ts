import type { UserAuthSuccess } from '@/types';

const {
  mockEnsureAdoServiceHooksForRepositories,
  mockEnsureGiteaWebhooksForRepositories,
  mockEnsureGitLabWebhooksForProjects,
  mockRemoveBitbucketWebhooksForRepositories,
  mockRemoveAdoServiceHooksForRepositories,
  mockRemoveGiteaWebhooksForRepositories,
  mockRemoveGitLabWebhooksForProjects,
  mockEnvironmentMappingRows,
  mockResolveDeploymentEnvVar,
  mockGetDeploymentGitHubRoomoteMentionEnabled,
  mockGetDeploymentMarkRoomotePrReadyAfterCleanReview,
  mockSetDeploymentGitHubRoomoteMentionEnabled,
  mockSetDeploymentMarkRoomotePrReadyAfterCleanReview,
  mockSyncAdoRepositories,
  mockSyncGitLabRepositories,
  mockSyncGiteaRepositories,
  mockUpsertDeploymentEnvironmentVariables,
  mockResolveAdoOrganization,
  mockValidateAdoToken,
  mockValidateAdoEntraCredentials,
  mockValidateAdoDelegatedCredentials,
  mockDescribeAdoApiError,
  mockValidateGiteaToken,
  mockDeleteDeploymentEnvironmentVariables,
  mockGetPersistedEnvironmentVariableValues,
  mockDeleteGitLabOAuthConnection,
  mockDeleteGiteaOAuthConnection,
  mockDeleteBitbucketOAuthConnection,
  mockGetGitLabOAuthConnection,
  mockGetGiteaOAuthConnection,
  mockGetBitbucketOAuthConnection,
  mockClearGitLabDeploymentUserCache,
  mockClearGiteaDeploymentUserCache,
  mockClearBitbucketDeploymentUserCache,
  mockDisableGitHubAppCommand,
  mockRepositoryRows,
  mockPersistedEnvVarNames,
  mockRepositoryFindMany,
  mockTransaction,
  mockTxUpdate,
  mockTxDelete,
  mockTxDeleteWhere,
  mockTxExecute,
  mockEnv,
} = vi.hoisted(() => ({
  mockEnsureAdoServiceHooksForRepositories: vi.fn(),
  mockEnsureGiteaWebhooksForRepositories: vi.fn(),
  mockEnsureGitLabWebhooksForProjects: vi.fn(),
  mockRemoveBitbucketWebhooksForRepositories: vi.fn(),
  mockRemoveAdoServiceHooksForRepositories: vi.fn(),
  mockRemoveGiteaWebhooksForRepositories: vi.fn(),
  mockRemoveGitLabWebhooksForProjects: vi.fn(),
  mockEnvironmentMappingRows: { rows: [] as { repositoryId: string }[] },
  mockResolveDeploymentEnvVar: vi.fn(),
  mockGetDeploymentGitHubRoomoteMentionEnabled: vi.fn(),
  mockGetDeploymentMarkRoomotePrReadyAfterCleanReview: vi.fn(),
  mockSetDeploymentGitHubRoomoteMentionEnabled: vi.fn(),
  mockSetDeploymentMarkRoomotePrReadyAfterCleanReview: vi.fn(),
  mockSyncAdoRepositories: vi.fn(),
  mockSyncGitLabRepositories: vi.fn(),
  mockSyncGiteaRepositories: vi.fn(),
  mockUpsertDeploymentEnvironmentVariables: vi.fn(),
  mockResolveAdoOrganization: vi.fn(),
  mockValidateAdoToken: vi.fn(),
  mockValidateAdoEntraCredentials: vi.fn(),
  mockValidateAdoDelegatedCredentials: vi.fn(),
  mockDescribeAdoApiError: vi.fn(),
  mockValidateGiteaToken: vi.fn(),
  mockDeleteDeploymentEnvironmentVariables: vi.fn(),
  mockGetPersistedEnvironmentVariableValues: vi.fn(),
  mockDeleteGitLabOAuthConnection: vi.fn(),
  mockDeleteGiteaOAuthConnection: vi.fn(),
  mockDeleteBitbucketOAuthConnection: vi.fn(),
  mockGetGitLabOAuthConnection: vi.fn(),
  mockGetGiteaOAuthConnection: vi.fn(),
  mockGetBitbucketOAuthConnection: vi.fn(),
  mockClearGitLabDeploymentUserCache: vi.fn(),
  mockClearGiteaDeploymentUserCache: vi.fn(),
  mockClearBitbucketDeploymentUserCache: vi.fn(),
  mockDisableGitHubAppCommand: vi.fn(),
  mockRepositoryRows: { rows: [] as unknown[] },
  mockPersistedEnvVarNames: { names: [] as string[] },
  mockRepositoryFindMany: vi.fn(),
  mockTransaction: vi.fn(),
  mockTxUpdate: vi.fn(),
  mockTxDelete: vi.fn(),
  mockTxDeleteWhere: vi.fn(),
  mockTxExecute: vi.fn(),
  mockEnv: {
    R_APP_URL: 'https://roomote.example.com',
    R_PUBLIC_URL: undefined as string | undefined,
    TRPC_URL: 'http://localhost:3000/trpc',
  },
}));

vi.mock('@roomote/ado', () => ({
  describeAdoApiError: mockDescribeAdoApiError,
  ensureAdoServiceHooksForRepositories:
    mockEnsureAdoServiceHooksForRepositories,
  removeAdoServiceHooksForRepositories:
    mockRemoveAdoServiceHooksForRepositories,
  resolveAdoOrganization: mockResolveAdoOrganization,
  syncAdoRepositories: mockSyncAdoRepositories,
  validateAdoDelegatedCredentials: mockValidateAdoDelegatedCredentials,
  validateAdoEntraCredentials: mockValidateAdoEntraCredentials,
  validateAdoToken: mockValidateAdoToken,
}));

vi.mock('@roomote/bitbucket', () => ({
  clearBitbucketDeploymentUserCache: mockClearBitbucketDeploymentUserCache,
  deleteBitbucketOAuthConnection: mockDeleteBitbucketOAuthConnection,
  getBitbucketOAuthConnection: mockGetBitbucketOAuthConnection,
  removeBitbucketWebhooksForRepositories:
    mockRemoveBitbucketWebhooksForRepositories,
}));

vi.mock('@roomote/gitea', () => ({
  clearGiteaDeploymentUserCache: mockClearGiteaDeploymentUserCache,
  deleteGiteaOAuthConnection: mockDeleteGiteaOAuthConnection,
  getGiteaOAuthConnection: mockGetGiteaOAuthConnection,
  ensureGiteaWebhooksForRepositories: mockEnsureGiteaWebhooksForRepositories,
  normalizeGiteaBaseUrl: (value: string) =>
    value.startsWith('http') ? value : `https://${value}`,
  removeGiteaWebhooksForRepositories: mockRemoveGiteaWebhooksForRepositories,
  resolveGiteaBaseUrl: vi.fn().mockResolvedValue('https://gitea.example.com'),
  syncGiteaRepositories: mockSyncGiteaRepositories,
  validateGiteaToken: mockValidateGiteaToken,
}));

vi.mock('@roomote/gitlab', () => ({
  clearGitLabDeploymentUserCache: mockClearGitLabDeploymentUserCache,
  deleteGitLabOAuthConnection: mockDeleteGitLabOAuthConnection,
  getGitLabOAuthConnection: mockGetGitLabOAuthConnection,
  buildGitLabApiBaseUrl: (value: string) =>
    `${value.replace(/\/+$/, '')}/api/v4`,
  ensureGitLabWebhooksForProjects: mockEnsureGitLabWebhooksForProjects,
  normalizeGitLabBaseUrl: (value: string) =>
    value.startsWith('http') ? value : `https://${value}`,
  removeGitLabWebhooksForProjects: mockRemoveGitLabWebhooksForProjects,
  resolveGitLabBaseUrl: vi.fn().mockResolvedValue('https://gitlab.com'),
  syncGitLabRepositories: mockSyncGitLabRepositories,
}));

vi.mock('@roomote/db/server', () => ({
  and: (...conditions: unknown[]) => ({ conditions }),
  authAccounts: {
    accountId: 'auth_accounts.account_id',
    providerId: 'auth_accounts.provider_id',
  },
  db: {
    select: (columns: { name?: unknown }) => ({
      from: () =>
        Promise.resolve(
          columns.name
            ? mockPersistedEnvVarNames.names.map((name) => ({ name }))
            : mockEnvironmentMappingRows.rows,
        ),
    }),
    query: {
      repositories: { findMany: mockRepositoryFindMany },
    },
    transaction: mockTransaction,
  },
  eq: (left: unknown, right: unknown) => ({ left, right }),
  environmentRepositoryMappings: {
    repositoryId: 'environment_repository_mappings.repository_id',
  },
  environmentVariables: {
    name: 'environment_variables.name',
  },
  repositories: {
    sourceControlProvider: 'repositories.source_control_provider',
  },
  getDeploymentPrAction: vi.fn(),
  getDeploymentGitHubRoomoteMentionEnabled:
    mockGetDeploymentGitHubRoomoteMentionEnabled,
  getDeploymentMarkRoomotePrReadyAfterCleanReview:
    mockGetDeploymentMarkRoomotePrReadyAfterCleanReview,
  resolveDeploymentEnvVar: mockResolveDeploymentEnvVar,
  sql: vi.fn(() => 'sql-expression'),
  setDeploymentPrAction: vi.fn(),
  setDeploymentGitHubRoomoteMentionEnabled:
    mockSetDeploymentGitHubRoomoteMentionEnabled,
  setDeploymentMarkRoomotePrReadyAfterCleanReview:
    mockSetDeploymentMarkRoomotePrReadyAfterCleanReview,
}));

vi.mock('@/lib/server', () => ({
  getRepositories: vi.fn(),
}));

vi.mock('@/lib/server/env', () => ({
  Env: mockEnv,
}));

vi.mock('../environment-variables', () => ({
  assertAdmin: (auth: UserAuthSuccess) => {
    if (!auth.isAdmin) {
      throw new Error('Unauthorized');
    }
  },
  upsertDeploymentEnvironmentVariables:
    mockUpsertDeploymentEnvironmentVariables,
  deleteDeploymentEnvironmentVariables:
    mockDeleteDeploymentEnvironmentVariables,
  getPersistedEnvironmentVariableValues:
    mockGetPersistedEnvironmentVariableValues,
}));

vi.mock('../github/mutations', () => ({
  disableGitHubAppCommand: mockDisableGitHubAppCommand,
}));

vi.mock('@roomote/sdk/server/automation-recommendations', () => ({
  enqueueAutomationSignalPrefetch: vi.fn(async () => undefined),
}));

import {
  assertValidSourceControlConfigInput,
  clearSourceControlConfigCommand,
  getGitHubRoomoteMentionCommand,
  getMarkRoomotePrReadyAfterCleanReviewCommand,
  setMarkRoomotePrReadyAfterCleanReviewCommand,
  setGitHubRoomoteMentionCommand,
  syncRepositoriesCommand,
} from './index';

function buildMockAuth(
  overrides: Partial<UserAuthSuccess> = {},
): UserAuthSuccess {
  return {
    success: true,
    userType: 'user',
    userId: 'source-control-user',
    isAdmin: true,
    name: 'Source Control Tester',
    primaryEmail: 'source-control@example.com',
    resource: {},
    ...overrides,
  } as UserAuthSuccess;
}

describe('GitHub Roomote mention setting commands', () => {
  it('returns the deployment setting to admins', async () => {
    mockGetDeploymentGitHubRoomoteMentionEnabled.mockResolvedValueOnce(true);

    await expect(
      getGitHubRoomoteMentionCommand(buildMockAuth()),
    ).resolves.toEqual({ enabled: true });
  });

  it('persists an admin opt-out', async () => {
    mockSetDeploymentGitHubRoomoteMentionEnabled.mockResolvedValueOnce(false);

    await expect(
      setGitHubRoomoteMentionCommand(buildMockAuth(), { enabled: false }),
    ).resolves.toEqual({ enabled: false });
    expect(mockSetDeploymentGitHubRoomoteMentionEnabled).toHaveBeenCalledWith(
      false,
    );
  });

  it('rejects non-admin updates', async () => {
    await expect(
      setGitHubRoomoteMentionCommand(buildMockAuth({ isAdmin: false }), {
        enabled: false,
      }),
    ).rejects.toThrow('Unauthorized');
  });
});

describe('clean review ready setting commands', () => {
  it('returns the deployment setting to admins', async () => {
    mockGetDeploymentMarkRoomotePrReadyAfterCleanReview.mockResolvedValueOnce(
      true,
    );

    await expect(
      getMarkRoomotePrReadyAfterCleanReviewCommand(buildMockAuth()),
    ).resolves.toEqual({ enabled: true });
  });

  it('persists an admin opt-in', async () => {
    mockSetDeploymentMarkRoomotePrReadyAfterCleanReview.mockResolvedValueOnce(
      true,
    );

    await expect(
      setMarkRoomotePrReadyAfterCleanReviewCommand(buildMockAuth(), {
        enabled: true,
      }),
    ).resolves.toEqual({ enabled: true });
    expect(
      mockSetDeploymentMarkRoomotePrReadyAfterCleanReview,
    ).toHaveBeenCalledWith(true);
  });

  it('rejects non-admin updates', async () => {
    await expect(
      setMarkRoomotePrReadyAfterCleanReviewCommand(
        buildMockAuth({ isAdmin: false }),
        { enabled: true },
      ),
    ).rejects.toThrow('Unauthorized');
  });
});

describe('source-control commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.R_APP_URL = 'https://roomote.example.com';
    mockEnv.R_PUBLIC_URL = undefined;
    mockEnv.TRPC_URL = 'http://localhost:3000/trpc';
    mockResolveDeploymentEnvVar.mockResolvedValue(null);
    mockGetPersistedEnvironmentVariableValues.mockResolvedValue({});
    mockGetGitLabOAuthConnection.mockResolvedValue(null);
    mockGetGiteaOAuthConnection.mockResolvedValue(null);
    mockGetBitbucketOAuthConnection.mockResolvedValue(null);
    mockRepositoryRows.rows = [];
    mockPersistedEnvVarNames.names = [
      'R_GITHUB_APP_ID',
      'GITLAB_CLIENT_ID',
      'GITEA_CLIENT_ID',
      'ADO_ORGANIZATION',
      'BITBUCKET_CLIENT_ID',
    ];
    mockRepositoryFindMany.mockImplementation(
      async () => mockRepositoryRows.rows,
    );
    mockTxUpdate.mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    });
    mockTxDeleteWhere.mockResolvedValue(undefined);
    mockTxDelete.mockReturnValue({ where: mockTxDeleteWhere });
    mockTransaction.mockImplementation(async (callback) =>
      callback({
        execute: mockTxExecute,
        update: mockTxUpdate,
        delete: mockTxDelete,
      }),
    );
    mockEnvironmentMappingRows.rows = [
      { repositoryId: 'ado-repo-row-1' },
      { repositoryId: 'gitea-repo-row-1' },
    ];
    mockSyncAdoRepositories.mockResolvedValue({
      success: true,
      repositories: [
        {
          id: 'ado-repo-row-1',
          externalRepoId: 'repo-1',
          fullName: 'acme/Platform/backend',
          permissions: { projectId: 'project-1' },
        },
      ],
    });
    mockSyncGiteaRepositories.mockResolvedValue({
      success: true,
      repositories: [{ id: 'gitea-repo-row-1', fullName: 'Roomote/gitea-app' }],
    });
    mockRemoveGiteaWebhooksForRepositories.mockResolvedValue([]);
    mockRemoveAdoServiceHooksForRepositories.mockResolvedValue([]);
    mockRemoveGitLabWebhooksForProjects.mockResolvedValue([]);
    mockRemoveBitbucketWebhooksForRepositories.mockResolvedValue([]);
    mockEnsureGitLabWebhooksForProjects.mockResolvedValue([
      { status: 'created', repositoryFullName: 'acme/gitlab-app' },
    ]);
    mockEnsureGiteaWebhooksForRepositories.mockResolvedValue([
      { status: 'created', repositoryFullName: 'Roomote/gitea-app' },
      { status: 'updated', repositoryFullName: 'Roomote/gitea-api' },
      {
        status: 'failed',
        repositoryFullName: 'Roomote/gitea-admin',
        error: 'requires repository admin access',
      },
    ]);
    mockEnsureAdoServiceHooksForRepositories.mockResolvedValue([
      { status: 'created', repositoryFullName: 'acme/Platform/backend' },
    ]);
    mockValidateGiteaToken.mockResolvedValue({ status: 'valid' });
    mockDisableGitHubAppCommand.mockResolvedValue({ success: true });
    mockResolveAdoOrganization.mockResolvedValue(null);
    mockValidateAdoToken.mockResolvedValue({ status: 'valid' });
    mockValidateAdoEntraCredentials.mockResolvedValue({ status: 'valid' });
    mockValidateAdoDelegatedCredentials.mockResolvedValue({ status: 'valid' });
    mockDescribeAdoApiError.mockImplementation(async (error: unknown) =>
      error instanceof Error ? error.message : String(error),
    );
  });

  it('clears persisted GitHub credentials and deactivates stale installations', async () => {
    const auth = buildMockAuth();

    await expect(
      clearSourceControlConfigCommand(auth, { provider: 'github' }),
    ).resolves.toEqual({
      success: true,
      provider: 'github',
      warnings: [],
    });

    expect(mockDisableGitHubAppCommand).toHaveBeenCalledWith(auth);
    expect(mockTxExecute).toHaveBeenCalledWith('sql-expression');
    expect(mockTxExecute.mock.invocationCallOrder[0]).toBeLessThan(
      mockDisableGitHubAppCommand.mock.invocationCallOrder[0]!,
    );
    expect(mockDeleteDeploymentEnvironmentVariables).toHaveBeenCalledWith(
      expect.anything(),
      [
        'R_GITHUB_APP_SLUG',
        'R_GITHUB_APP_ID',
        'R_GITHUB_APP_PRIVATE_KEY',
        'R_GITHUB_CLIENT_ID',
        'R_GITHUB_CLIENT_SECRET',
        'R_GITHUB_WEBHOOK_SECRET',
      ],
    );
  });

  it('does not clear GitHub credentials when stale installations cannot be deactivated', async () => {
    mockDisableGitHubAppCommand.mockResolvedValue({
      success: false,
      error: 'Failed to disconnect GitHub.',
    });

    await expect(
      clearSourceControlConfigCommand(buildMockAuth(), { provider: 'github' }),
    ).rejects.toThrow('Failed to disconnect GitHub.');
    expect(mockDeleteDeploymentEnvironmentVariables).not.toHaveBeenCalled();
  });

  it.each([
    [
      'gitlab',
      mockRemoveGitLabWebhooksForProjects,
      mockDeleteGitLabOAuthConnection,
    ],
    [
      'gitea',
      mockRemoveGiteaWebhooksForRepositories,
      mockDeleteGiteaOAuthConnection,
    ],
    [
      'bitbucket',
      mockRemoveBitbucketWebhooksForRepositories,
      mockDeleteBitbucketOAuthConnection,
    ],
    ['ado', mockRemoveAdoServiceHooksForRepositories, null],
  ] as const)(
    'removes %s hooks, credentials, and local configuration',
    async (provider, removeHooks, deleteOAuth) => {
      mockRepositoryRows.rows = [
        {
          id: `${provider}-repository-id`,
          externalRepoId: `${provider}-external-id`,
          fullName: 'acme/project/repository',
          permissions: { projectId: 'ado-project-id' },
        },
      ];

      await expect(
        clearSourceControlConfigCommand(buildMockAuth(), { provider }),
      ).resolves.toMatchObject({ success: true, provider, warnings: [] });

      expect(removeHooks).toHaveBeenCalledOnce();
      if (deleteOAuth) {
        expect(deleteOAuth).toHaveBeenCalledOnce();
      }
      if (provider === 'gitlab') {
        expect(mockClearGitLabDeploymentUserCache).toHaveBeenCalledOnce();
      } else if (provider === 'gitea') {
        expect(mockClearGiteaDeploymentUserCache).toHaveBeenCalledOnce();
      } else if (provider === 'bitbucket') {
        expect(mockClearBitbucketDeploymentUserCache).toHaveBeenCalledOnce();
      }
      expect(mockDeleteDeploymentEnvironmentVariables).toHaveBeenCalledOnce();
      expect(mockTxUpdate).toHaveBeenCalledOnce();
    },
  );

  it('returns hook cleanup failures as warnings while removing local configuration', async () => {
    mockRepositoryRows.rows = [
      {
        id: 'gitlab-repository-id',
        externalRepoId: '42',
        fullName: 'acme/project',
        permissions: {},
      },
    ];
    mockRemoveGitLabWebhooksForProjects.mockResolvedValue([
      {
        repositoryFullName: 'acme/project',
        status: 'failed',
        error: 'GitLab denied webhook deletion.',
      },
    ]);

    await expect(
      clearSourceControlConfigCommand(buildMockAuth(), { provider: 'gitlab' }),
    ).resolves.toEqual({
      success: true,
      provider: 'gitlab',
      warnings: [
        {
          kind: 'webhook_cleanup',
          repositoryId: 'gitlab-repository-id',
          repositoryFullName: 'acme/project',
          message: 'GitLab denied webhook deletion.',
        },
      ],
    });
    expect(mockDeleteDeploymentEnvironmentVariables).toHaveBeenCalledOnce();
  });

  it('deletes the exact persisted Azure DevOps delegated account', async () => {
    mockGetPersistedEnvironmentVariableValues.mockResolvedValue({
      ADO_LINKED_ACCOUNT_ID: 'delegated-account-id',
    });

    await clearSourceControlConfigCommand(buildMockAuth(), { provider: 'ado' });

    expect(mockTxDelete).toHaveBeenCalledOnce();
    expect(mockTxDeleteWhere).toHaveBeenCalledWith({
      conditions: [
        { left: 'auth_accounts.provider_id', right: 'ado' },
        {
          left: 'auth_accounts.account_id',
          right: 'delegated-account-id',
        },
      ],
    });
  });

  it('does not remove provider state for runtime-only configuration', async () => {
    mockPersistedEnvVarNames.names = [];

    await expect(
      clearSourceControlConfigCommand(buildMockAuth(), { provider: 'gitlab' }),
    ).resolves.toEqual({
      success: true,
      provider: 'gitlab',
      warnings: [],
    });

    expect(mockRepositoryFindMany).not.toHaveBeenCalled();
    expect(mockRemoveGitLabWebhooksForProjects).not.toHaveBeenCalled();
    expect(mockDeleteGitLabOAuthConnection).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it.each([
    [
      'gitlab',
      mockGetGitLabOAuthConnection,
      mockRemoveGitLabWebhooksForProjects,
      mockDeleteGitLabOAuthConnection,
    ],
    [
      'gitea',
      mockGetGiteaOAuthConnection,
      mockRemoveGiteaWebhooksForRepositories,
      mockDeleteGiteaOAuthConnection,
    ],
    [
      'bitbucket',
      mockGetBitbucketOAuthConnection,
      mockRemoveBitbucketWebhooksForRepositories,
      mockDeleteBitbucketOAuthConnection,
    ],
  ] as const)(
    'removes a persisted %s OAuth connection when client credentials come from runtime configuration',
    async (
      provider,
      getOAuthConnection,
      removeHooks,
      deleteOAuthConnection,
    ) => {
      mockPersistedEnvVarNames.names = [];
      getOAuthConnection.mockResolvedValue({ accessToken: 'oauth-token' });
      mockRepositoryRows.rows = [
        {
          id: `${provider}-repository-id`,
          externalRepoId: `${provider}-external-id`,
          fullName: 'acme/project/repository',
          permissions: {},
        },
      ];

      await expect(
        clearSourceControlConfigCommand(buildMockAuth(), { provider }),
      ).resolves.toMatchObject({ success: true, provider, warnings: [] });

      expect(removeHooks).toHaveBeenCalledOnce();
      expect(deleteOAuthConnection).toHaveBeenCalledOnce();
      expect(mockTxUpdate).toHaveBeenCalledOnce();
    },
  );

  it('returns OAuth cleanup failures as warnings while removing local configuration', async () => {
    mockDeleteGitLabOAuthConnection.mockRejectedValueOnce(
      new Error('OAuth secret deletion failed.'),
    );

    await expect(
      clearSourceControlConfigCommand(buildMockAuth(), { provider: 'gitlab' }),
    ).resolves.toEqual({
      success: true,
      provider: 'gitlab',
      warnings: [
        {
          kind: 'oauth_cleanup',
          message: 'OAuth secret deletion failed.',
        },
      ],
    });
    expect(mockTransaction).toHaveBeenCalledOnce();
  });

  it('rejects non-admin configuration removal', async () => {
    await expect(
      clearSourceControlConfigCommand(buildMockAuth({ isAdmin: false }), {
        provider: 'gitea',
      }),
    ).rejects.toThrow('Unauthorized');
    expect(mockRepositoryFindMany).not.toHaveBeenCalled();
  });

  it('surfaces fatal database cleanup failures', async () => {
    mockTransaction.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(
      clearSourceControlConfigCommand(buildMockAuth(), { provider: 'gitea' }),
    ).rejects.toThrow('database unavailable');
  });

  it('creates GitLab webhooks during the OAuth-triggered repository sync', async () => {
    mockSyncGitLabRepositories.mockResolvedValue({
      success: true,
      repositories: [
        {
          id: 'gitlab-repo-row-1',
          externalRepoId: '42',
          fullName: 'acme/gitlab-app',
        },
      ],
    });

    const result = await syncRepositoriesCommand(buildMockAuth(), {
      provider: 'gitlab',
    });

    expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        values: [
          expect.objectContaining({
            name: 'GITLAB_WEBHOOK_SECRET',
            value: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
        ],
      }),
    );
    expect(mockEnsureGitLabWebhooksForProjects).toHaveBeenCalledWith({
      projects: [{ projectId: '42', repositoryFullName: 'acme/gitlab-app' }],
      webhookUrl: 'https://roomote.example.com/api/webhooks/gitlab',
      secretToken: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result).toMatchObject({
      success: true,
      webhooks: {
        status: 'configured',
        created: 1,
        skippedUnmapped: 0,
      },
    });
  });

  it('prefers R_PUBLIC_URL for GitLab webhooks when R_APP_URL is loopback', async () => {
    mockEnv.R_APP_URL = 'http://127.0.0.1:13000';
    mockEnv.R_PUBLIC_URL = 'https://customer.example';
    mockEnv.TRPC_URL = 'http://127.0.0.1:13001';
    mockSyncGitLabRepositories.mockResolvedValue({
      success: true,
      repositories: [
        {
          id: 'gitlab-repo-row-1',
          externalRepoId: '42',
          fullName: 'acme/gitlab-app',
        },
      ],
    });

    const result = await syncRepositoriesCommand(buildMockAuth(), {
      provider: 'gitlab',
    });

    expect(mockEnsureGitLabWebhooksForProjects).toHaveBeenCalledWith({
      projects: [{ projectId: '42', repositoryFullName: 'acme/gitlab-app' }],
      webhookUrl: 'https://customer.example/api/webhooks/gitlab',
      secretToken: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result).toMatchObject({
      success: true,
      webhooks: {
        status: 'configured',
        created: 1,
      },
    });
  });

  it('prefers R_PUBLIC_URL over an internal non-loopback R_APP_URL when TRPC is loopback', async () => {
    mockEnv.R_APP_URL = 'http://roomote.internal:3000';
    mockEnv.R_PUBLIC_URL = 'https://customer.example';
    mockEnv.TRPC_URL = 'http://127.0.0.1:13001';
    mockSyncGitLabRepositories.mockResolvedValue({
      success: true,
      repositories: [
        {
          id: 'gitlab-repo-row-1',
          externalRepoId: '42',
          fullName: 'acme/gitlab-app',
        },
      ],
    });

    await syncRepositoriesCommand(buildMockAuth(), {
      provider: 'gitlab',
    });

    expect(mockEnsureGitLabWebhooksForProjects).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookUrl: 'https://customer.example/api/webhooks/gitlab',
      }),
    );
  });

  it('keeps a non-loopback TRPC_URL as the GitLab webhook host when set', async () => {
    mockEnv.R_APP_URL = 'http://127.0.0.1:13000';
    mockEnv.R_PUBLIC_URL = 'https://customer.example';
    mockEnv.TRPC_URL = 'https://api.customer.example';
    mockSyncGitLabRepositories.mockResolvedValue({
      success: true,
      repositories: [
        {
          id: 'gitlab-repo-row-1',
          externalRepoId: '42',
          fullName: 'acme/gitlab-app',
        },
      ],
    });

    await syncRepositoriesCommand(buildMockAuth(), {
      provider: 'gitlab',
    });

    expect(mockEnsureGitLabWebhooksForProjects).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookUrl: 'https://api.customer.example/api/webhooks/gitlab',
      }),
    );
  });

  it('skips GitLab webhook setup when no publicly reachable Roomote URL is configured', async () => {
    mockEnv.R_APP_URL = 'http://127.0.0.1:13000';
    mockEnv.R_PUBLIC_URL = undefined;
    mockEnv.TRPC_URL = 'http://127.0.0.1:13001';
    mockSyncGitLabRepositories.mockResolvedValue({
      success: true,
      repositories: [
        {
          id: 'gitlab-repo-row-1',
          externalRepoId: '42',
          fullName: 'acme/gitlab-app',
        },
      ],
    });

    const result = await syncRepositoriesCommand(buildMockAuth(), {
      provider: 'gitlab',
    });

    expect(mockEnsureGitLabWebhooksForProjects).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      webhooks: {
        status: 'skipped',
      },
    });
  });

  it('syncs Gitea repositories and configures pull request webhooks', async () => {
    const result = await syncRepositoriesCommand(buildMockAuth(), {
      provider: 'gitea',
    });

    expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'source-control-user',
        values: [
          expect.objectContaining({
            name: 'GITEA_WEBHOOK_SECRET',
            value: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
        ],
      }),
    );
    expect(mockEnsureGiteaWebhooksForRepositories).toHaveBeenCalledWith({
      repositories: [{ repositoryFullName: 'Roomote/gitea-app' }],
      webhookUrl: 'https://roomote.example.com/api/webhooks/gitea',
      secretToken: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result).toMatchObject({
      success: true,
      webhooks: {
        status: 'configured',
        created: 1,
        updated: 1,
        skippedUnmapped: 0,
        removed: 0,
        failed: [
          expect.objectContaining({
            repositoryFullName: 'Roomote/gitea-admin',
          }),
        ],
      },
    });
  });

  it('hooks all Gitea repositories returned by OAuth', async () => {
    mockSyncGiteaRepositories.mockResolvedValue({
      success: true,
      repositories: [
        { id: 'gitea-repo-row-1', fullName: 'Roomote/gitea-app' },
        { id: 'gitea-repo-row-2', fullName: 'acme/private-work-repo' },
      ],
    });
    mockEnsureGiteaWebhooksForRepositories.mockResolvedValue([
      { status: 'created', repositoryFullName: 'Roomote/gitea-app' },
      { status: 'created', repositoryFullName: 'acme/private-work-repo' },
    ]);

    const result = await syncRepositoriesCommand(buildMockAuth(), {
      provider: 'gitea',
    });

    expect(mockEnsureGiteaWebhooksForRepositories).toHaveBeenCalledWith(
      expect.objectContaining({
        repositories: [
          { repositoryFullName: 'Roomote/gitea-app' },
          { repositoryFullName: 'acme/private-work-repo' },
        ],
      }),
    );
    expect(mockRemoveGiteaWebhooksForRepositories).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      webhooks: {
        status: 'configured',
        created: 2,
        updated: 0,
        failed: [],
        skippedUnmapped: 0,
        removed: 0,
      },
    });
  });

  it('creates webhooks when no synced repository is environment-mapped', async () => {
    mockEnvironmentMappingRows.rows = [];
    mockEnsureGiteaWebhooksForRepositories.mockResolvedValue([
      { status: 'created', repositoryFullName: 'Roomote/gitea-app' },
    ]);

    const result = await syncRepositoriesCommand(buildMockAuth(), {
      provider: 'gitea',
    });

    expect(mockEnsureGiteaWebhooksForRepositories).toHaveBeenCalledWith(
      expect.objectContaining({
        repositories: [{ repositoryFullName: 'Roomote/gitea-app' }],
      }),
    );
    expect(result).toMatchObject({
      success: true,
      webhooks: {
        status: 'configured',
        created: 1,
        updated: 0,
        failed: [],
        skippedUnmapped: 0,
        removed: 0,
      },
    });
  });

  it('syncs Azure DevOps repositories and configures pull request service hooks', async () => {
    const result = await syncRepositoriesCommand(buildMockAuth(), {
      provider: 'ado',
    });

    expect(mockUpsertDeploymentEnvironmentVariables).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: 'source-control-user',
        values: [
          expect.objectContaining({
            name: 'ADO_WEBHOOK_SECRET',
            value: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
        ],
      }),
    );
    expect(mockEnsureAdoServiceHooksForRepositories).toHaveBeenCalledWith({
      repositories: [
        {
          repositoryFullName: 'acme/Platform/backend',
          repositoryId: 'repo-1',
          projectId: 'project-1',
        },
      ],
      webhookUrl: 'https://roomote.example.com/api/webhooks/ado',
      secretToken: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result).toMatchObject({
      success: true,
      webhooks: {
        status: 'configured',
        created: 1,
        updated: 0,
        failed: [],
        skippedUnmapped: 0,
        removed: 0,
      },
    });
  });

  it('rejects invalid Azure DevOps tokens during config validation', async () => {
    mockValidateAdoToken.mockResolvedValue({
      status: 'invalid',
      error: 'Azure DevOps rejected the token.',
    });

    await expect(
      assertValidSourceControlConfigInput({
        provider: 'ado',
        values: {
          ADO_ORGANIZATION: 'acme',
          ADO_TOKEN: 'ado-token',
        },
      }),
    ).rejects.toThrow('Azure DevOps rejected the token.');

    expect(mockValidateAdoToken).toHaveBeenCalledWith({
      token: 'ado-token',
      organization: 'acme',
      baseUrl: undefined,
    });
  });

  it('validates a new Azure DevOps token against the saved organization', async () => {
    mockResolveAdoOrganization.mockResolvedValue('acme');

    await assertValidSourceControlConfigInput({
      provider: 'ado',
      values: { ADO_TOKEN: 'ado-token' },
    });

    expect(mockValidateAdoToken).toHaveBeenCalledWith({
      token: 'ado-token',
      organization: 'acme',
      baseUrl: undefined,
    });
  });

  it('skips Azure DevOps token validation when no organization is available', async () => {
    await assertValidSourceControlConfigInput({
      provider: 'ado',
      values: { ADO_TOKEN: 'ado-token' },
    });

    expect(mockValidateAdoToken).not.toHaveBeenCalled();
  });

  it('probes Microsoft Entra service-principal credentials before saving them', async () => {
    mockValidateAdoEntraCredentials.mockResolvedValue({
      status: 'invalid',
      error: 'Azure DevOps rejected the Microsoft Entra credential.',
    });

    await expect(
      assertValidSourceControlConfigInput({
        provider: 'ado',
        values: {
          ADO_ORGANIZATION: 'acme',
          ADO_AUTH_MODE: 'entra',
          ADO_CLIENT_ID: 'client-id',
          ADO_CLIENT_SECRET: 'client-secret',
          ADO_TENANT_ID: 'tenant-id',
        },
      }),
    ).rejects.toThrow('Azure DevOps rejected the Microsoft Entra credential.');

    expect(mockValidateAdoEntraCredentials).toHaveBeenCalledWith({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tenantId: 'tenant-id',
      organization: 'acme',
      baseUrl: undefined,
    });
    expect(mockValidateAdoToken).not.toHaveBeenCalled();
  });

  it('probes runtime-configured Entra credentials the form submits as blank', async () => {
    // The Settings form sends an empty string for every field already
    // satisfied by a runtime env var. Falling back on those blanks is what
    // makes the probe run at all; otherwise the whole check is skipped and
    // an unusable credential saves cleanly.
    mockResolveAdoOrganization.mockResolvedValue('acme');
    mockResolveDeploymentEnvVar.mockImplementation(
      async (name: string) =>
        ({
          ADO_CLIENT_ID: 'runtime-client-id',
          ADO_CLIENT_SECRET: 'runtime-client-secret',
          ADO_TENANT_ID: 'runtime-tenant-id',
        })[name] ?? null,
    );
    mockValidateAdoEntraCredentials.mockResolvedValue({
      status: 'invalid',
      error: 'Azure DevOps rejected the Microsoft Entra credential.',
    });

    await expect(
      assertValidSourceControlConfigInput({
        provider: 'ado',
        values: {
          ADO_ORGANIZATION: '',
          ADO_CLIENT_ID: '',
          ADO_CLIENT_SECRET: '',
          ADO_TENANT_ID: '',
          ADO_AUTH_MODE: 'entra',
          ADO_LINKED_ACCOUNT_ID: '',
        },
      }),
    ).rejects.toThrow('Azure DevOps rejected the Microsoft Entra credential.');

    expect(mockValidateAdoEntraCredentials).toHaveBeenCalledWith({
      clientId: 'runtime-client-id',
      clientSecret: 'runtime-client-secret',
      tenantId: 'runtime-tenant-id',
      organization: 'acme',
      baseUrl: undefined,
    });
  });

  it('probes the delegated Azure DevOps account once it is linked', async () => {
    await assertValidSourceControlConfigInput({
      provider: 'ado',
      values: {
        ADO_ORGANIZATION: 'acme',
        ADO_AUTH_MODE: 'delegated',
        ADO_CLIENT_ID: 'client-id',
        ADO_CLIENT_SECRET: 'client-secret',
        ADO_TENANT_ID: 'tenant-id',
        ADO_LINKED_ACCOUNT_ID: 'ado-user@example.com',
      },
    });

    expect(mockValidateAdoDelegatedCredentials).toHaveBeenCalledWith({
      linkedAccountId: 'ado-user@example.com',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tenantId: 'tenant-id',
      organization: 'acme',
      baseUrl: undefined,
    });
  });

  it('skips the delegated probe before the Microsoft account is connected', async () => {
    await assertValidSourceControlConfigInput({
      provider: 'ado',
      allowIncompleteDelegated: true,
      values: {
        ADO_ORGANIZATION: 'acme',
        ADO_AUTH_MODE: 'delegated',
        ADO_CLIENT_ID: 'client-id',
        ADO_CLIENT_SECRET: 'client-secret',
        ADO_TENANT_ID: 'tenant-id',
        ADO_LINKED_ACCOUNT_ID: '',
      },
    });

    expect(mockValidateAdoDelegatedCredentials).not.toHaveBeenCalled();
  });

  it('explains a rejected Azure DevOps credential instead of echoing the sync status', async () => {
    mockSyncAdoRepositories.mockRejectedValue(
      new Error('Azure DevOps API request failed: 401 Unauthorized'),
    );
    mockDescribeAdoApiError.mockResolvedValue(
      'Azure DevOps rejected the Microsoft Entra credential (status 401). Add the API permissions.',
    );

    await expect(
      syncRepositoriesCommand(buildMockAuth(), { provider: 'ado' }),
    ).resolves.toEqual({
      success: false,
      error:
        'Azure DevOps rejected the Microsoft Entra credential (status 401). Add the API permissions.',
    });
  });

  it('requires Gitea OAuth credentials during config validation', async () => {
    await expect(
      assertValidSourceControlConfigInput({
        provider: 'gitea',
        values: {
          GITEA_BASE_URL: 'https://gitea.example.com',
        },
      }),
    ).rejects.toThrow(
      'Configure the Gitea OAuth client ID and secret to continue.',
    );
  });
});
