import type { UserAuthSuccess } from '@/types';

const {
  mockEnsureAdoServiceHooksForRepositories,
  mockEnsureGiteaWebhooksForRepositories,
  mockRemoveAdoServiceHooksForRepositories,
  mockRemoveGiteaWebhooksForRepositories,
  mockRemoveGitLabWebhooksForProjects,
  mockEnvironmentMappingRows,
  mockResolveDeploymentEnvVar,
  mockSyncAdoRepositories,
  mockSyncGiteaRepositories,
  mockUpsertDeploymentEnvironmentVariables,
  mockResolveAdoOrganization,
  mockValidateAdoToken,
  mockValidateGiteaToken,
  mockEnv,
} = vi.hoisted(() => ({
  mockEnsureAdoServiceHooksForRepositories: vi.fn(),
  mockEnsureGiteaWebhooksForRepositories: vi.fn(),
  mockRemoveAdoServiceHooksForRepositories: vi.fn(),
  mockRemoveGiteaWebhooksForRepositories: vi.fn(),
  mockRemoveGitLabWebhooksForProjects: vi.fn(),
  mockEnvironmentMappingRows: { rows: [] as { repositoryId: string }[] },
  mockResolveDeploymentEnvVar: vi.fn(),
  mockSyncAdoRepositories: vi.fn(),
  mockSyncGiteaRepositories: vi.fn(),
  mockUpsertDeploymentEnvironmentVariables: vi.fn(),
  mockResolveAdoOrganization: vi.fn(),
  mockValidateAdoToken: vi.fn(),
  mockValidateGiteaToken: vi.fn(),
  mockEnv: {
    R_APP_URL: 'https://roomote.example.com',
    TRPC_URL: 'http://localhost:3000/trpc',
  },
}));

vi.mock('@roomote/ado', () => ({
  ensureAdoServiceHooksForRepositories:
    mockEnsureAdoServiceHooksForRepositories,
  removeAdoServiceHooksForRepositories:
    mockRemoveAdoServiceHooksForRepositories,
  resolveAdoOrganization: mockResolveAdoOrganization,
  syncAdoRepositories: mockSyncAdoRepositories,
  validateAdoToken: mockValidateAdoToken,
}));

vi.mock('@roomote/gitea', () => ({
  ensureGiteaWebhooksForRepositories: mockEnsureGiteaWebhooksForRepositories,
  normalizeGiteaBaseUrl: (value: string) =>
    value.startsWith('http') ? value : `https://${value}`,
  removeGiteaWebhooksForRepositories: mockRemoveGiteaWebhooksForRepositories,
  resolveGiteaBaseUrl: vi.fn().mockResolvedValue('https://gitea.example.com'),
  syncGiteaRepositories: mockSyncGiteaRepositories,
  validateGiteaToken: mockValidateGiteaToken,
}));

vi.mock('@roomote/gitlab', () => ({
  buildGitLabApiBaseUrl: (value: string) =>
    `${value.replace(/\/+$/, '')}/api/v4`,
  ensureGitLabWebhooksForProjects: vi.fn(),
  normalizeGitLabBaseUrl: (value: string) =>
    value.startsWith('http') ? value : `https://${value}`,
  removeGitLabWebhooksForProjects: mockRemoveGitLabWebhooksForProjects,
  resolveGitLabBaseUrl: vi.fn().mockResolvedValue('https://gitlab.com'),
  syncGitLabRepositories: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    select: () => ({
      from: () => Promise.resolve(mockEnvironmentMappingRows.rows),
    }),
  },
  environmentRepositoryMappings: {
    repositoryId: 'environment_repository_mappings.repository_id',
  },
  environmentVariables: {
    name: 'environment_variables.name',
  },
  getDeploymentPrAction: vi.fn(),
  resolveDeploymentEnvVar: mockResolveDeploymentEnvVar,
  setDeploymentPrAction: vi.fn(),
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
}));

import {
  assertValidSourceControlConfigInput,
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
    featureFlags: {},
    resource: {},
    ...overrides,
  } as UserAuthSuccess;
}

describe('source-control commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.R_APP_URL = 'https://roomote.example.com';
    mockEnv.TRPC_URL = 'http://localhost:3000/trpc';
    mockResolveDeploymentEnvVar.mockResolvedValue(null);
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
    mockResolveAdoOrganization.mockResolvedValue(null);
    mockValidateAdoToken.mockResolvedValue({ status: 'valid' });
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

  it('only hooks environment-mapped repositories and removes hooks from unmapped ones', async () => {
    mockSyncGiteaRepositories.mockResolvedValue({
      success: true,
      repositories: [
        { id: 'gitea-repo-row-1', fullName: 'Roomote/gitea-app' },
        { id: 'gitea-repo-row-2', fullName: 'acme/private-work-repo' },
      ],
    });
    mockEnsureGiteaWebhooksForRepositories.mockResolvedValue([
      { status: 'created', repositoryFullName: 'Roomote/gitea-app' },
    ]);
    mockRemoveGiteaWebhooksForRepositories.mockResolvedValue([
      { status: 'removed', repositoryFullName: 'acme/private-work-repo' },
    ]);

    const result = await syncRepositoriesCommand(buildMockAuth(), {
      provider: 'gitea',
    });

    expect(mockEnsureGiteaWebhooksForRepositories).toHaveBeenCalledWith(
      expect.objectContaining({
        repositories: [{ repositoryFullName: 'Roomote/gitea-app' }],
      }),
    );
    expect(mockRemoveGiteaWebhooksForRepositories).toHaveBeenCalledWith({
      repositories: [{ repositoryFullName: 'acme/private-work-repo' }],
      webhookUrl: 'https://roomote.example.com/api/webhooks/gitea',
    });
    expect(result).toMatchObject({
      success: true,
      webhooks: {
        status: 'configured',
        created: 1,
        updated: 0,
        failed: [],
        skippedUnmapped: 1,
        removed: 1,
      },
    });
  });

  it('does not create webhooks when no synced repository is environment-mapped', async () => {
    mockEnvironmentMappingRows.rows = [];
    mockRemoveGiteaWebhooksForRepositories.mockResolvedValue([
      { status: 'not_found', repositoryFullName: 'Roomote/gitea-app' },
    ]);

    const result = await syncRepositoriesCommand(buildMockAuth(), {
      provider: 'gitea',
    });

    expect(mockEnsureGiteaWebhooksForRepositories).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      webhooks: {
        status: 'configured',
        created: 0,
        updated: 0,
        failed: [],
        skippedUnmapped: 1,
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

  it('rejects invalid Gitea tokens during config validation', async () => {
    mockValidateGiteaToken.mockResolvedValue({
      status: 'invalid',
      error: 'Gitea rejected the token.',
    });

    await expect(
      assertValidSourceControlConfigInput({
        provider: 'gitea',
        values: {
          GITEA_BASE_URL: 'https://gitea.example.com',
          GITEA_TOKEN: 'gitea-token',
        },
      }),
    ).rejects.toThrow('Gitea rejected the token.');
  });
});
