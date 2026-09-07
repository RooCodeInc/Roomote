const {
  mockCreateGitHubTokenWithMetadata,
  mockFindMany,
  mockFindFirst,
  mockFindEnvironmentFirst,
  mockResolveTaskRunWritableRepositories,
} = vi.hoisted(() => ({
  mockCreateGitHubTokenWithMetadata: vi.fn(),
  mockFindMany: vi.fn(),
  mockFindFirst: vi.fn(),
  mockFindEnvironmentFirst: vi.fn(),
  mockResolveTaskRunWritableRepositories: vi.fn(),
}));

vi.mock('@roomote/auth', () => ({
  createGitHubTokenWithMetadata: mockCreateGitHubTokenWithMetadata,
}));

vi.mock('@roomote/db/server', () => ({
  resolveTaskRunWritableRepositories: mockResolveTaskRunWritableRepositories,
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
    },
  },
  eq: vi.fn((left: unknown, right: unknown) => ({ type: 'eq', left, right })),
  githubInstallations: {},
  githubPendingInstallations: {},
  environments: {
    id: 'environments.id',
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
  },
}));

import { db, type TaskRun } from '@roomote/db/server';

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

describe('createTaskRunGitHubToken', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockResolveTaskRunWritableRepositories.mockResolvedValue(null);
    mockFindEnvironmentFirst.mockResolvedValue({
      config: { repositories: [{ repository: 'ExampleOrg/example-backend' }] },
    });
    mockFindMany.mockResolvedValue([
      {
        fullName: 'ExampleOrg/example-backend',
        installationId: 'install-exampleorg',
        githubRepoId: 101,
        sourceControlProvider: 'github',
        isActive: true,
      },
    ]);
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

  it('uses the environment repositories installation for environment tasks', async () => {
    mockFindEnvironmentFirst.mockResolvedValue({
      config: { repositories: [{ repository: 'Roomote/example-app' }] },
    });
    mockResolveTaskRunWritableRepositories.mockResolvedValue([
      {
        fullName: 'Roomote/example-app',
        installationId: 'install-roomote',
        githubRepoId: 201,
        sourceControlProvider: 'github',
        isActive: true,
      },
    ]);

    await expect(
      createTaskRunGitHubToken(
        buildTaskRun({
          repo: '__all_repositories__',
          environmentId: '14f1f7c4-b126-4b3f-a6a8-e37f7d299f4d',
        } as TaskRun['payload']),
      ),
    ).resolves.toBe('ghs_test_token');

    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockCreateGitHubTokenWithMetadata).toHaveBeenCalledWith(
      {
        type: 'installationId',
        installationId: 'install-roomote',
        repositoryIds: [201],
      },
      undefined,
      undefined,
    );
  });

  it('rejects environment repository sets that span multiple installations', async () => {
    mockFindEnvironmentFirst.mockResolvedValue({
      config: {
        repositories: [
          { repository: 'owner-a/api' },
          { repository: 'owner-b/web' },
        ],
      },
    });
    mockResolveTaskRunWritableRepositories.mockResolvedValue([
      {
        fullName: 'owner-a/api',
        installationId: 'install-a',
        sourceControlProvider: 'github',
        isActive: true,
        githubRepoId: 101,
      },
      {
        fullName: 'owner-b/web',
        installationId: 'install-b',
        sourceControlProvider: 'github',
        isActive: true,
        githubRepoId: 102,
      },
    ]);

    await expect(
      createTaskRunGitHubToken(
        buildTaskRun({
          repo: '__all_repositories__',
          environmentId: '14f1f7c4-b126-4b3f-a6a8-e37f7d299f4d',
          repositoryProviders: {
            'owner-a/api': 'github',
            'owner-b/web': 'gitlab',
          },
        } as TaskRun['payload']),
      ),
    ).rejects.toThrow(
      'Environment repositories for task run 123 must resolve to one GitHub installation',
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

  it('uses explicit active repository IDs for true all-repository tasks', async () => {
    await expect(
      createTaskRunGitHubToken(
        buildTaskRun({ repo: '__all_repositories__' } as TaskRun['payload']),
      ),
    ).resolves.toBe('ghs_test_token');

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
        ],
      },
    });
    expect(mockFindFirst).not.toHaveBeenCalled();
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

  it('uses explicit IDs for a single repository without an installation-wide fallback', async () => {
    await expect(
      createTaskRunGitHubToken(
        buildTaskRun({
          repo: 'ExampleOrg/example-backend',
        } as TaskRun['payload']),
      ),
    ).resolves.toBe('ghs_test_token');

    expect(mockFindFirst).not.toHaveBeenCalled();
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
            type: 'inArray',
            left: 'repositories.fullName',
            right: ['ExampleOrg/example-backend'],
          },
        ],
      },
    });
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

  it('ignores unrelated installations while including extra active repositories on the prepared installation', async () => {
    mockResolveTaskRunWritableRepositories.mockResolvedValue([
      {
        fullName: 'ExampleOrg/example-backend',
        sourceControlProvider: 'github',
        isActive: true,
        installationId: 'install-exampleorg',
        githubRepoId: 101,
      },
      {
        fullName: 'ExampleOrg/unmapped-active',
        sourceControlProvider: 'github',
        isActive: true,
        installationId: 'install-exampleorg',
        githubRepoId: 102,
      },
      {
        fullName: 'group/project',
        sourceControlProvider: 'gitlab',
        isActive: true,
        installationId: 'install-gitlab',
        githubRepoId: null,
      },
      {
        fullName: 'OtherOrg/unrelated',
        sourceControlProvider: 'github',
        isActive: true,
        installationId: 'install-otherorg',
        githubRepoId: 103,
      },
      {
        fullName: 'ExampleOrg/inactive',
        sourceControlProvider: 'github',
        isActive: false,
        installationId: 'install-exampleorg',
        githubRepoId: 104,
      },
    ]);
    const taskRun = buildTaskRun({
      repo: '__all_repositories__',
      environmentId: '14f1f7c4-b126-4b3f-a6a8-e37f7d299f4d',
      selectedRepositories: [
        'ExampleOrg/example-backend',
        'ExampleOrg/inactive',
      ],
      repositoryProviders: {
        'ExampleOrg/example-backend': 'gitlab',
        'ExampleOrg/inactive': 'github',
        'group/project': 'gitlab',
      },
    } as TaskRun['payload']);

    await expect(createTaskRunGitHubToken(taskRun)).resolves.toBe(
      'ghs_test_token',
    );

    expect(mockResolveTaskRunWritableRepositories).toHaveBeenCalledWith(
      db,
      taskRun,
    );
    expect(mockFindMany).not.toHaveBeenCalled();
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

  it('permits one active GitHub installation when preparation has no GitHub anchor', async () => {
    mockFindEnvironmentFirst.mockResolvedValue({
      config: { repositories: [{ repository: 'group/project' }] },
    });
    mockResolveTaskRunWritableRepositories.mockResolvedValue([
      {
        fullName: 'group/project',
        sourceControlProvider: 'gitlab',
        isActive: true,
        installationId: null,
      },
      {
        fullName: 'ExampleOrg/example-backend',
        sourceControlProvider: 'github',
        isActive: true,
        installationId: 'install-exampleorg',
        githubRepoId: 101,
      },
      {
        fullName: 'ExampleOrg/unmapped-active',
        sourceControlProvider: 'github',
        isActive: true,
        installationId: 'install-exampleorg',
        githubRepoId: 102,
      },
    ]);
    await expect(
      createTaskRunGitHubToken(
        buildTaskRun({
          repo: 'group/project',
          environmentId: '14f1f7c4-b126-4b3f-a6a8-e37f7d299f4d',
        } as TaskRun['payload']),
      ),
    ).resolves.toBe('ghs_test_token');
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

  it('clearly rejects multiple active GitHub installations without a prepared anchor', async () => {
    mockFindEnvironmentFirst.mockResolvedValue({
      config: { repositories: [{ repository: 'group/project' }] },
    });
    mockResolveTaskRunWritableRepositories.mockResolvedValue([
      {
        fullName: 'owner-a/api',
        sourceControlProvider: 'github',
        isActive: true,
        installationId: 'install-a',
        githubRepoId: 101,
      },
      {
        fullName: 'owner-b/web',
        sourceControlProvider: 'github',
        isActive: true,
        installationId: 'install-b',
        githubRepoId: 102,
      },
    ]);
    await expect(
      createTaskRunGitHubToken(
        buildTaskRun({
          repo: 'group/project',
          environmentId: '14f1f7c4-b126-4b3f-a6a8-e37f7d299f4d',
        } as TaskRun['payload']),
      ),
    ).rejects.toThrow(
      'has no prepared GitHub repository anchor and must resolve to one active GitHub installation',
    );
    expect(mockCreateGitHubTokenWithMetadata).not.toHaveBeenCalled();
  });

  it.each(['missing', 'inactive'])(
    'denies a %s single repository excluded from active rows',
    async (state) => {
      mockFindMany.mockResolvedValue([]);

      await expect(
        createTaskRunGitHubToken(
          buildTaskRun({
            repo: `ExampleOrg/${state}`,
          } as TaskRun['payload']),
        ),
      ).rejects.toThrow(
        `Selected repositories not found for task run 123: ExampleOrg/${state}`,
      );

      expect(mockFindMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          conditions: expect.arrayContaining([
            { type: 'eq', left: 'repositories.isActive', right: true },
          ]),
        }),
      });
      expect(mockFindFirst).not.toHaveBeenCalled();
      expect(mockCreateGitHubTokenWithMetadata).not.toHaveBeenCalled();
    },
  );

  it('denies a selected set with a missing or inactive repository instead of issuing a partial token', async () => {
    await expect(
      createTaskRunGitHubToken(
        buildTaskRun({
          repo: '__all_repositories__',
          selectedRepositories: [
            'ExampleOrg/example-backend',
            'ExampleOrg/missing',
          ],
        } as TaskRun['payload']),
      ),
    ).rejects.toThrow(
      'Selected repositories not found for task run 123: ExampleOrg/missing',
    );

    expect(mockCreateGitHubTokenWithMetadata).not.toHaveBeenCalled();
  });

  it.each(['all repositories', 'environment'])(
    'fails closed when %s resolves no rows',
    async (scope) => {
      mockFindMany.mockResolvedValue([]);
      if (scope === 'environment') {
        mockResolveTaskRunWritableRepositories.mockResolvedValue([]);
      }

      await expect(
        createTaskRunGitHubToken(
          buildTaskRun({
            repo: '__all_repositories__',
            ...(scope === 'environment'
              ? { environmentId: '14f1f7c4-b126-4b3f-a6a8-e37f7d299f4d' }
              : {}),
          } as TaskRun['payload']),
        ),
      ).rejects.toThrow();

      if (scope === 'environment') expect(mockFindMany).not.toHaveBeenCalled();
      expect(mockFindFirst).not.toHaveBeenCalled();
      expect(mockCreateGitHubTokenWithMetadata).not.toHaveBeenCalled();
    },
  );

  it.each(['repository', 'installation'])(
    'fails closed when only some rows have %s IDs',
    async (missingId) => {
      mockFindMany.mockResolvedValue([
        {
          fullName: 'owner/api',
          installationId: 'install-a',
          githubRepoId: 101,
        },
        {
          fullName: 'owner/web',
          installationId: missingId === 'installation' ? null : 'install-a',
          githubRepoId: missingId === 'repository' ? null : 102,
        },
      ]);

      await expect(
        createTaskRunGitHubToken(
          buildTaskRun({
            repo: '__all_repositories__',
          } as TaskRun['payload']),
        ),
      ).rejects.toThrow('incomplete installation or repository ids');
      expect(mockCreateGitHubTokenWithMetadata).not.toHaveBeenCalled();
    },
  );

  it('fails closed when all-repository tasks span multiple installations', async () => {
    mockFindMany.mockResolvedValue([
      {
        fullName: 'owner-a/api',
        installationId: 'install-a',
        githubRepoId: 101,
      },
      {
        fullName: 'owner-b/web',
        installationId: 'install-b',
        githubRepoId: 102,
      },
    ]);

    await expect(
      createTaskRunGitHubToken(
        buildTaskRun({ repo: '__all_repositories__' } as TaskRun['payload']),
      ),
    ).rejects.toThrow(
      'Active repositories for task run 123 span multiple GitHub installations',
    );
    expect(mockCreateGitHubTokenWithMetadata).not.toHaveBeenCalled();
  });

  it('propagates unauthorized helper rejection without querying repositories or issuing a token', async () => {
    const unauthorized = Object.assign(new Error('Environment access denied'), {
      status: 401,
    });
    mockResolveTaskRunWritableRepositories.mockRejectedValue(unauthorized);
    const operation = vi.fn();

    await expect(
      withTaskRunGitHubTokenRetry(
        buildTaskRun({
          repo: '__all_repositories__',
          environmentId: '14f1f7c4-b126-4b3f-a6a8-e37f7d299f4d',
        } as TaskRun['payload']),
        operation,
      ),
    ).rejects.toBe(unauthorized);

    expect(mockResolveTaskRunWritableRepositories).toHaveBeenCalledTimes(1);
    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockCreateGitHubTokenWithMetadata).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
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
      {
        type: 'installationId',
        installationId: 'install-exampleorg',
        repositoryIds: [101],
      },
      undefined,
      {
        cache: true,
        maxCacheAgeMs: 15 * 60 * 1000,
      },
    );
    expect(mockCreateGitHubTokenWithMetadata).toHaveBeenNthCalledWith(
      2,
      {
        type: 'installationId',
        installationId: 'install-exampleorg',
        repositoryIds: [101],
      },
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
