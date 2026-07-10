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
}));

import type { Run } from '@roomote/db/server';

import { createCloudJobGitHubToken } from '../api';

function buildCloudJob(payload: Run['payload']): Run {
  return {
    id: 123,
    payload,
  } as Run;
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

describe('createCloudJobGitHubToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateGitHubToken.mockResolvedValue('ghs_test_token');
  });

  it('uses the selected repositories installation for scoped multi-repo tasks', async () => {
    mockFindMany.mockResolvedValue([
      {
        fullName: 'LogSharpDoo/ViradaBMS-BE',
        installationId: 'install-logsharpdoo',
        githubRepoId: 101,
      },
      {
        fullName: 'LogSharpDoo/ViradaBMS-React',
        installationId: 'install-logsharpdoo',
        githubRepoId: 102,
      },
    ]);

    await expect(
      createCloudJobGitHubToken(
        buildCloudJob({
          repo: '__all_repositories__',
          selectedRepositories: [
            'LogSharpDoo/ViradaBMS-BE',
            'LogSharpDoo/ViradaBMS-React',
          ],
        } as Run['payload']),
      ),
    ).resolves.toBe('ghs_test_token');

    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockCreateGitHubToken).toHaveBeenCalledWith({
      type: 'installationId',
      installationId: 'install-logsharpdoo',
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
      createCloudJobGitHubToken(
        buildCloudJob({
          repo: '__all_repositories__',
          environmentId: '14f1f7c4-b126-4b3f-a6a8-e37f7d299f4d',
        } as Run['payload']),
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
      createCloudJobGitHubToken(
        buildCloudJob({
          repo: '__all_repositories__',
          environmentId: '14f1f7c4-b126-4b3f-a6a8-e37f7d299f4d',
        } as Run['payload']),
      ),
    ).rejects.toThrow(
      'Environment repositories for cloud job 123 span multiple GitHub installations',
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
      createCloudJobGitHubToken(
        buildCloudJob({
          repo: '__all_repositories__',
          selectedRepositories: ['owner-a/api', 'owner-b/web'],
        } as Run['payload']),
      ),
    ).rejects.toThrow(
      'Selected repositories for cloud job 123 span multiple GitHub installations',
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
      createCloudJobGitHubToken(
        buildCloudJob({
          repo: '__all_repositories__',
          selectedRepositories: ['owner-a/api'],
        } as Run['payload']),
      ),
    ).rejects.toThrow(
      'Selected repositories for cloud job 123 resolved no GitHub repository ids',
    );

    expect(mockCreateGitHubToken).not.toHaveBeenCalled();
  });

  it('falls back to the active installation for true all-repository tasks', async () => {
    await expect(
      createCloudJobGitHubToken(
        buildCloudJob({ repo: '__all_repositories__' } as Run['payload']),
      ),
    ).resolves.toBe('ghs_test_token');

    expect(mockFindMany).not.toHaveBeenCalled();
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockCreateGitHubToken).toHaveBeenCalledWith({
      type: 'activeInstallation',
    });
  });
});
