const {
  mockCreateGitHubToken,
  mockFindMany,
  mockFindFirst,
  mockFindEnvironmentFirst,
} = vi.hoisted(() => ({
  mockCreateGitHubToken: vi.fn(),
  mockFindMany: vi.fn(),
  mockFindFirst: vi.fn(),
  mockFindEnvironmentFirst: vi.fn(),
}));

vi.mock('@roomote/auth', () => ({
  createGitHubToken: mockCreateGitHubToken,
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
  },
  resolveDeploymentEnvVar: vi.fn().mockResolvedValue(null),
}));

import type { TaskRun } from '@roomote/db/server';

import { createTaskRunGitHubToken } from '../api';

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
    mockCreateGitHubToken.mockResolvedValue('ghs_test_token');
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
    expect(mockCreateGitHubToken).toHaveBeenCalledWith({
      type: 'installationId',
      installationId: 'install-exampleorg',
      repositoryIds: [101, 102],
    });
  });

  it('uses the environment repositories installation for environment tasks', async () => {
    mockFindEnvironmentFirst.mockResolvedValue({
      id: '14f1f7c4-b126-4b3f-a6a8-e37f7d299f4d',
      config: buildEnvironmentConfig(['Roomote/example-app']),
    });
    mockFindMany.mockResolvedValue([
      {
        fullName: 'Roomote/example-app',
        installationId: 'install-roomote',
        githubRepoId: 201,
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
    expect(mockCreateGitHubToken).toHaveBeenCalledWith({
      type: 'installationId',
      installationId: 'install-roomote',
      repositoryIds: [201],
    });
  });

  it('rejects environment repository sets that span multiple installations', async () => {
    mockFindEnvironmentFirst.mockResolvedValue({
      id: '14f1f7c4-b126-4b3f-a6a8-e37f7d299f4d',
      config: buildEnvironmentConfig(['owner-a/api', 'owner-b/web']),
    });
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
          environmentId: '14f1f7c4-b126-4b3f-a6a8-e37f7d299f4d',
        } as TaskRun['payload']),
      ),
    ).rejects.toThrow(
      'Environment repositories for task run 123 span multiple GitHub installations',
    );

    expect(mockCreateGitHubToken).not.toHaveBeenCalled();
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

    expect(mockCreateGitHubToken).not.toHaveBeenCalled();
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

    expect(mockCreateGitHubToken).not.toHaveBeenCalled();
  });

  it('falls back to the active installation for true all-repository tasks', async () => {
    await expect(
      createTaskRunGitHubToken(
        buildTaskRun({ repo: '__all_repositories__' } as TaskRun['payload']),
      ),
    ).resolves.toBe('ghs_test_token');

    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockCreateGitHubToken).toHaveBeenCalledWith({
      type: 'activeInstallation',
    });
  });
});
