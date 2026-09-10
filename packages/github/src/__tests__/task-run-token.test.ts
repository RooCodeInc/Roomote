const {
  mockCreateGitHubTokenWithMetadata,
  mockFindMany,
  mockFindFirst,
  mockFindEnvironmentFirst,
  mockFindMappings,
} = vi.hoisted(() => ({
  mockCreateGitHubTokenWithMetadata: vi.fn(),
  mockFindMany: vi.fn(),
  mockFindFirst: vi.fn(),
  mockFindEnvironmentFirst: vi.fn(),
  mockFindMappings: vi.fn(),
}));

vi.mock('@roomote/auth', () => ({
  createGitHubTokenWithMetadata: mockCreateGitHubTokenWithMetadata,
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...conditions: unknown[]) => ({ type: 'and', conditions })),
  db: {
    query: {
      repositories: {
        findMany: mockFindMany,
        findFirst: mockFindFirst,
      },
      environments: {
        findFirst: mockFindEnvironmentFirst,
      },
      environmentRepositoryMappings: { findMany: mockFindMappings },
    },
  },
  eq: vi.fn((left: unknown, right: unknown) => ({ type: 'eq', left, right })),
  githubInstallations: {},
  githubPendingInstallations: {},
  environments: {
    id: 'environments.id',
  },
  environmentRepositoryMappings: {
    environmentId: 'environmentRepositoryMappings.environmentId',
  },
  inArray: vi.fn((left: unknown, right: unknown) => ({
    type: 'inArray',
    left,
    right,
  })),
  isNull: vi.fn((value: unknown) => ({ type: 'isNull', value })),
  repositories: {
    fullName: 'repositories.fullName',
    isActive: 'repositories.isActive',
    sourceControlProvider: 'repositories.sourceControlProvider',
    installationId: 'repositories.installationId',
  },
}));

import type { TaskRun } from '@roomote/db/server';

import {
  createTaskRunGitHubToken,
  createTaskRunWorkerGitHubTokenWithMetadata,
  withTaskRunGitHubTokenRetry,
} from '../api';

function buildTaskRun(payload: TaskRun['payload']): TaskRun {
  return {
    id: 123,
    payload,
  } as TaskRun;
}

function buildEnvironmentConfig(repositories: string[]) {
  return {
    version: 1,
    name: 'Test environment',
    repositories: repositories.map((repository, index) => ({
      id: `repo${index + 1}`,
      repository,
      path: repository.split('/').at(-1) ?? `repo${index + 1}`,
    })),
    primaryRepo: 'repo1',
    runtime: {
      devcontainer: {
        type: 'generated',
        inputs: {
          runtimeEnvironmentConfig: {
            repositories: repositories.map((repository) => ({ repository })),
          },
        },
      },
    },
    agent: {},
    secrets: {},
    identity: {},
    preview: {},
  };
}

describe('createTaskRunGitHubToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateGitHubTokenWithMetadata.mockResolvedValue({
      token: 'ghs_test_token',
      expiresAt: new Date('2030-01-01T01:00:00.000Z'),
    });
  });

  it('uses the selected repositories installation for scoped multi-repo tasks', async () => {
    mockFindMany.mockResolvedValue([
      {
        fullName: 'ExampleOrg/example-backend',
        installationId: 'install-exampleorg',
        githubRepoId: 101,
      },
      {
        fullName: 'ExampleOrg/example-frontend',
        installationId: 'install-exampleorg',
        githubRepoId: 102,
      },
    ]);

    await expect(
      createTaskRunGitHubToken(
        buildTaskRun({
          repo: '__all_repositories__',
          selectedRepositories: [
            'ExampleOrg/example-backend',
            'ExampleOrg/example-frontend',
          ],
        } as TaskRun['payload']),
      ),
    ).resolves.toBe('ghs_test_token');

    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockCreateGitHubTokenWithMetadata).toHaveBeenCalledWith(
      {
        type: 'installationId',
        installationId: 'install-exampleorg',
        repositoryIds: [101, 102],
      },
      undefined,
      undefined,
    );
  });

  it('ignores selected repositories mapped to another provider', async () => {
    mockFindMany.mockResolvedValue([
      {
        fullName: 'ExampleOrg/example-backend',
        installationId: 'install-exampleorg',
        githubRepoId: 101,
      },
    ]);

    await expect(
      createTaskRunGitHubToken(
        buildTaskRun({
          repo: 'ExampleOrg/example-backend',
          selectedRepositories: ['ExampleOrg/example-backend', 'group/project'],
          repositoryProviders: {
            'ExampleOrg/example-backend': 'github',
            'group/project': 'gitlab',
          },
        } as TaskRun['payload']),
      ),
    ).resolves.toBe('ghs_test_token');

    expect(mockCreateGitHubTokenWithMetadata).toHaveBeenCalledWith(
      {
        type: 'installationId',
        installationId: 'install-exampleorg',
        repositoryIds: [101],
      },
      undefined,
      undefined,
    );
  });

  it('ignores selected repository names omitted from a provider map', async () => {
    mockFindMany.mockResolvedValue([
      {
        fullName: 'ExampleOrg/example-backend',
        installationId: 'install-exampleorg',
        githubRepoId: 101,
      },
    ]);

    await expect(
      createTaskRunGitHubToken(
        buildTaskRun({
          repo: '__all_repositories__',
          selectedRepositories: [
            'ExampleOrg/example-backend',
            'group/project',
            'unknown/repository',
          ],
          repositoryProviders: {
            'ExampleOrg/example-backend': 'github',
            'group/project': 'gitlab',
          },
        } as TaskRun['payload']),
      ),
    ).resolves.toBe('ghs_test_token');
  });

  it('includes active repositories outside the environment only on its GitHub installation', async () => {
    mockFindEnvironmentFirst.mockResolvedValue({
      id: '14f1f7c4-b126-4b3f-a6a8-e37f7d299f4d',
      config: buildEnvironmentConfig(['Roomote/example-app']),
    });
    const prepared = {
      fullName: 'Roomote/example-app',
      installationId: 'install-roomote',
      githubRepoId: 201,
      isActive: true,
      sourceControlProvider: 'github',
    };
    mockFindMappings.mockResolvedValue([{ repository: prepared }]);
    const rows = [
      prepared,
      { ...prepared, fullName: 'Roomote/other-environment', githubRepoId: 202 },
      {
        ...prepared,
        fullName: 'Roomote/inactive',
        githubRepoId: 203,
        isActive: false,
      },
      {
        ...prepared,
        fullName: 'Other/app',
        githubRepoId: 204,
        installationId: 'other-install',
      },
      {
        ...prepared,
        fullName: 'Roomote/gitlab',
        githubRepoId: 205,
        sourceControlProvider: 'gitlab',
      },
    ];
    mockFindMany.mockImplementation(async ({ where }) =>
      rows.filter((row) =>
        where.conditions.every(
          ({ left, right }: { left: string; right: unknown }) =>
            row[left.replace('repositories.', '') as keyof typeof row] ===
            right,
        ),
      ),
    );

    await expect(
      createTaskRunGitHubToken(
        buildTaskRun({
          repo: '__all_repositories__',
          environmentId: '14f1f7c4-b126-4b3f-a6a8-e37f7d299f4d',
          repositoryProviders: { 'Roomote/example-app': 'github' },
        } as TaskRun['payload']),
      ),
    ).resolves.toBe('ghs_test_token');

    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockCreateGitHubTokenWithMetadata).toHaveBeenCalledWith(
      {
        type: 'installationId',
        installationId: 'install-roomote',
        repositoryIds: [201, 202],
      },
      undefined,
      undefined,
    );
    expect(mockFindMany).toHaveBeenCalledTimes(1);
    expect(mockFindMany).toHaveBeenCalledWith({
      where: {
        type: 'and',
        conditions: [
          {
            type: 'eq',
            left: 'repositories.sourceControlProvider',
            right: 'github',
          },
          { type: 'eq', left: 'repositories.isActive', right: true },
          {
            type: 'eq',
            left: 'repositories.installationId',
            right: 'install-roomote',
          },
        ],
      },
    });
  });

  it('does not anchor a GitHub installation from a same-name GitLab mapping', async () => {
    mockFindEnvironmentFirst.mockResolvedValue({
      id: 'environment-id',
      config: buildEnvironmentConfig(['acme/app']),
    });
    mockFindMappings.mockResolvedValue([
      {
        repository: {
          fullName: 'acme/app',
          sourceControlProvider: 'gitlab',
          isActive: true,
          installationId: null,
          githubRepoId: null,
        },
      },
    ]);
    mockFindMany.mockResolvedValue([
      {
        fullName: 'acme/app',
        sourceControlProvider: 'github',
        isActive: true,
        installationId: 'github-install',
        githubRepoId: 301,
      },
    ]);

    await expect(
      createTaskRunGitHubToken(
        buildTaskRun({
          repo: 'acme/app',
          environmentId: 'environment-id',
          repositoryProviders: { 'acme/app': 'github' },
        } as TaskRun['payload']),
      ),
    ).rejects.toThrow('Environment repositories');
    expect(mockFindMappings).toHaveBeenCalledWith({
      where: {
        type: 'eq',
        left: 'environmentRepositoryMappings.environmentId',
        right: 'environment-id',
      },
      with: { repository: true },
    });
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockCreateGitHubTokenWithMetadata).not.toHaveBeenCalled();
  });

  it('rejects environment repository sets that span multiple installations', async () => {
    mockFindEnvironmentFirst.mockResolvedValue({
      id: '14f1f7c4-b126-4b3f-a6a8-e37f7d299f4d',
      config: buildEnvironmentConfig(['owner-a/api', 'owner-b/web']),
    });
    mockFindMappings.mockResolvedValue([
      {
        repository: {
          fullName: 'owner-a/api',
          installationId: 'install-a',
          sourceControlProvider: 'github',
          isActive: true,
        },
      },
      {
        repository: {
          fullName: 'owner-b/web',
          installationId: 'install-b',
          sourceControlProvider: 'github',
          isActive: true,
        },
      },
    ]);

    await expect(
      createTaskRunGitHubToken(
        buildTaskRun({
          repo: '__all_repositories__',
          environmentId: '14f1f7c4-b126-4b3f-a6a8-e37f7d299f4d',
        } as TaskRun['payload']),
      ),
    ).rejects.toThrow(
      'Environment repositories for task run 123 span multiple GitHub installations',
    );

    expect(mockCreateGitHubTokenWithMetadata).not.toHaveBeenCalled();
  });

  it('rejects selected repository sets that span multiple installations', async () => {
    mockFindMany.mockResolvedValue([
      {
        fullName: 'owner-a/api',
        installationId: 'install-a',
      },
      {
        fullName: 'owner-b/web',
        installationId: 'install-b',
      },
    ]);

    await expect(
      createTaskRunGitHubToken(
        buildTaskRun({
          repo: '__all_repositories__',
          selectedRepositories: ['owner-a/api', 'owner-b/web'],
        } as TaskRun['payload']),
      ),
    ).rejects.toThrow(
      'Selected repositories for task run 123 span multiple GitHub installations',
    );

    expect(mockCreateGitHubTokenWithMetadata).not.toHaveBeenCalled();
  });

  it('fails closed when selected repositories resolve no GitHub repo ids', async () => {
    mockFindMany.mockResolvedValue([
      {
        fullName: 'owner-a/api',
        installationId: 'install-a',
        githubRepoId: null,
      },
    ]);

    await expect(
      createTaskRunGitHubToken(
        buildTaskRun({
          repo: '__all_repositories__',
          selectedRepositories: ['owner-a/api'],
        } as TaskRun['payload']),
      ),
    ).rejects.toThrow(
      'Selected repositories for task run 123 resolved no GitHub repository ids',
    );

    expect(mockCreateGitHubTokenWithMetadata).not.toHaveBeenCalled();
  });

  it('falls back to the active installation for true all-repository tasks', async () => {
    await expect(
      createTaskRunGitHubToken(
        buildTaskRun({ repo: '__all_repositories__' } as TaskRun['payload']),
      ),
    ).resolves.toBe('ghs_test_token');

    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockCreateGitHubTokenWithMetadata).toHaveBeenCalledWith(
      { type: 'activeInstallation' },
      undefined,
      undefined,
    );
  });

  it('preserves the installation token expiry for worker refresh scheduling', async () => {
    await expect(
      createTaskRunWorkerGitHubTokenWithMetadata(
        buildTaskRun({ repo: '__all_repositories__' } as TaskRun['payload']),
      ),
    ).resolves.toEqual({
      token: 'ghs_test_token',
      source: 'app',
      expiresAt: new Date('2030-01-01T01:00:00.000Z'),
    });
  });

  it('evicts a cached task token and retries once after a 401', async () => {
    mockCreateGitHubTokenWithMetadata
      .mockResolvedValueOnce({
        token: 'ghs_cached_token',
        expiresAt: new Date('2030-01-01T01:00:00.000Z'),
      })
      .mockResolvedValueOnce({
        token: 'ghs_fresh_token',
        expiresAt: new Date('2030-01-01T01:00:00.000Z'),
      });
    const unauthorized = Object.assign(new Error('Bad credentials'), {
      status: 401,
    });
    const operation = vi
      .fn<(token: string) => Promise<string>>()
      .mockRejectedValueOnce(unauthorized)
      .mockResolvedValueOnce('ok');
    const taskRun = buildTaskRun({
      repo: '__all_repositories__',
    } as TaskRun['payload']);

    await expect(withTaskRunGitHubTokenRetry(taskRun, operation)).resolves.toBe(
      'ok',
    );

    expect(operation).toHaveBeenNthCalledWith(1, 'ghs_cached_token');
    expect(operation).toHaveBeenNthCalledWith(2, 'ghs_fresh_token');
    expect(mockCreateGitHubTokenWithMetadata).toHaveBeenNthCalledWith(
      1,
      { type: 'activeInstallation' },
      undefined,
      {
        cache: true,
        maxCacheAgeMs: 15 * 60 * 1000,
      },
    );
    expect(mockCreateGitHubTokenWithMetadata).toHaveBeenNthCalledWith(
      2,
      { type: 'activeInstallation' },
      undefined,
      {
        cache: true,
        forceRefresh: true,
        maxCacheAgeMs: 15 * 60 * 1000,
      },
    );
  });

  it('does not retry non-authentication failures', async () => {
    const operation = vi
      .fn<(token: string) => Promise<string>>()
      .mockRejectedValueOnce(
        Object.assign(new Error('Forbidden'), { status: 403 }),
      );

    await expect(
      withTaskRunGitHubTokenRetry(
        buildTaskRun({ repo: '__all_repositories__' } as TaskRun['payload']),
        operation,
      ),
    ).rejects.toThrow('Forbidden');

    expect(operation).toHaveBeenCalledTimes(1);
    expect(mockCreateGitHubTokenWithMetadata).toHaveBeenCalledTimes(1);
  });
});
