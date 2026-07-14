import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { RunStatus, TaskPayloadKind } from '@roomote/types';
import type { TaskRun } from '@roomote/db/server';

const {
  mockEnvironmentVariablesFindMany,
  mockRepositoriesFindMany,
  mockEnvironmentsFindFirst,
  mockGitLabOAuthAccessToken,
} = vi.hoisted(() => ({
  mockEnvironmentVariablesFindMany: vi.fn(),
  mockRepositoriesFindMany: vi.fn(),
  mockEnvironmentsFindFirst: vi.fn(),
  mockGitLabOAuthAccessToken: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      environmentVariables: {
        findMany: (...args: unknown[]) =>
          mockEnvironmentVariablesFindMany(...args),
      },
      repositories: {
        findMany: (...args: unknown[]) => mockRepositoriesFindMany(...args),
        findFirst: vi.fn(),
      },
      environments: {
        findFirst: (...args: unknown[]) => mockEnvironmentsFindFirst(...args),
      },
    },
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
  environments: {
    id: 'environments.id',
  },
  repositories: {
    id: 'repositories.id',
    sourceControlProvider: 'repositories.sourceControlProvider',
    isActive: 'repositories.isActive',
    fullName: 'repositories.fullName',
    externalRepoId: 'repositories.externalRepoId',
  },
  and: vi.fn((...conditions: unknown[]) => ({ type: 'and', conditions })),
  eq: vi.fn((left: unknown, right: unknown) => ({ type: 'eq', left, right })),
  inArray: vi.fn((left: unknown, right: unknown) => ({
    type: 'inArray',
    left,
    right,
  })),
  stringifyDecryptedEnvVarValue: (value: unknown) => String(value),
  resolveDeploymentEnvVar: vi.fn(async (name: string) => {
    const value = process.env[name]?.trim();
    return value || null;
  }),
}));

vi.mock('@roomote/db/encryption', () => ({
  decryptSecrets: vi.fn(async (value: unknown) => value),
}));

vi.mock('../oauth', () => ({
  isGitLabOAuthAccessToken: () => false,
  resolveGitLabOAuthAccessToken: () => mockGitLabOAuthAccessToken(),
}));

import {
  buildGitLabApiBaseUrl,
  buildGitLabRepositoryValues,
  clearGitLabDeploymentUserCache,
  createTaskRunScopedGitLabTokens,
  createGitLabMergeRequestNote,
  ensureGitLabWebhooksForProjects,
  removeGitLabWebhooksForProjects,
  getGitLabDeploymentUser,
  resolveGitLabBaseUrl,
  revokeGitLabScopedProjectToken,
  type GitLabProject,
  listGitLabProjects,
  normalizeGitLabBaseUrl,
} from '../api';

function makeTaskRun(payload: TaskRun['payload']): TaskRun {
  return {
    id: 123,
    status: RunStatus.Dequeued,
    kind: 'fresh' as const,
    payloadKind: TaskPayloadKind.StandardTask,
    taskId: 'task-123',
    actingUserId: 'user-123',
    payload,
    result: null,
    artifacts: null,
  } as TaskRun;
}

describe('resolveGitLabBaseUrl', () => {
  const originalBaseUrl = process.env.GITLAB_BASE_URL;

  afterEach(() => {
    if (originalBaseUrl === undefined) {
      delete process.env.GITLAB_BASE_URL;
    } else {
      process.env.GITLAB_BASE_URL = originalBaseUrl;
    }
  });

  it('defaults to gitlab.com when GITLAB_BASE_URL is not set', async () => {
    delete process.env.GITLAB_BASE_URL;

    await expect(resolveGitLabBaseUrl()).resolves.toBe('https://gitlab.com');
  });

  it('normalizes a self-managed GITLAB_BASE_URL by trimming trailing slashes', async () => {
    process.env.GITLAB_BASE_URL = 'https://gitlab.example.com/';

    await expect(resolveGitLabBaseUrl()).resolves.toBe(
      'https://gitlab.example.com',
    );
  });

  it('accepts scheme-less URLs and removes API or hosted-account paths', async () => {
    process.env.GITLAB_BASE_URL = 'gitlab.example.com/api/v4/';

    await expect(resolveGitLabBaseUrl()).resolves.toBe(
      'https://gitlab.example.com',
    );
    expect(normalizeGitLabBaseUrl('gitlab.com/roomote/')).toBe(
      'https://gitlab.com',
    );
    expect(normalizeGitLabBaseUrl('gitlab.example.com////////')).toBe(
      'https://gitlab.example.com',
    );
  });
});

describe('buildGitLabApiBaseUrl', () => {
  it('appends the /api/v4 REST path to a base URL', () => {
    expect(buildGitLabApiBaseUrl('https://gitlab.example.com')).toBe(
      'https://gitlab.example.com/api/v4',
    );
  });

  it('handles a base URL with a trailing slash', () => {
    expect(buildGitLabApiBaseUrl('https://gitlab.example.com/')).toBe(
      'https://gitlab.example.com/api/v4',
    );
  });
});

describe('listGitLabProjects', () => {
  const originalBaseUrl = process.env.GITLAB_BASE_URL;

  afterEach(() => {
    if (originalBaseUrl === undefined) {
      delete process.env.GITLAB_BASE_URL;
    } else {
      process.env.GITLAB_BASE_URL = originalBaseUrl;
    }
  });

  it('lists accessible projects with membership and pagination parameters', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 1,
              name: 'api',
              path_with_namespace: 'acme/api',
              visibility: 'private',
            },
          ]),
          {
            status: 200,
            headers: { 'x-next-page': '2' },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 2,
              name: 'web',
              path_with_namespace: 'acme/web',
              visibility: 'public',
            },
          ]),
          { status: 200 },
        ),
      );

    const projects = await listGitLabProjects({
      apiBaseUrl: 'https://gitlab.example.com/api/v4',
      fetchImpl: fetchMock,
      token: 'glpat_test',
    });

    expect(projects.map((project) => project.path_with_namespace)).toEqual([
      'acme/api',
      'acme/web',
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://gitlab.example.com/api/v4/projects?membership=true&simple=true&archived=false&order_by=path&sort=asc&per_page=100&page=1',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'PRIVATE-TOKEN': 'glpat_test',
        }),
      }),
    );
  });

  it('requires a token', async () => {
    await expect(listGitLabProjects({ token: '' })).rejects.toThrow(
      'GitLab OAuth authorization is required to sync repositories.',
    );
  });

  it('derives the API base from GITLAB_BASE_URL for self-managed instances', async () => {
    process.env.GITLAB_BASE_URL = 'https://gitlab.example.com';

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    await listGitLabProjects({ fetchImpl: fetchMock, token: 'glpat_test' });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://gitlab.example.com/api/v4/projects?membership=true&simple=true&archived=false&order_by=path&sort=asc&per_page=100&page=1',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});

describe('buildGitLabRepositoryValues', () => {
  it('maps GitLab project fields into provider-tagged repository rows', () => {
    const project = {
      id: 123,
      name: 'backend',
      path_with_namespace: 'acme/platform/backend',
      description: 'Backend service',
      visibility: 'private',
      default_branch: 'develop',
      http_url_to_repo: 'https://gitlab.com/acme/platform/backend.git',
      web_url: 'https://gitlab.com/acme/platform/backend',
      permissions: { project_access: { access_level: 40 } },
    } satisfies GitLabProject;

    expect(
      buildGitLabRepositoryValues({
        project,
        linkedByUserId: 'user-1',
      }),
    ).toEqual({
      sourceControlProvider: 'gitlab',
      installationId: null,
      userId: null,
      githubRepoId: null,
      externalRepoId: '123',
      host: 'gitlab.com',
      name: 'backend',
      fullName: 'acme/platform/backend',
      description: 'Backend service',
      private: true,
      defaultBranch: 'develop',
      cloneUrl: 'https://gitlab.com/acme/platform/backend.git',
      htmlUrl: 'https://gitlab.com/acme/platform/backend',
      permissions: { project_access: { access_level: 40 } },
      isActive: true,
      linkedByUserId: 'user-1',
    });
  });

  it('falls back to the self-managed base URL for clone and web URLs', () => {
    const project = {
      id: 7,
      name: 'backend',
      path_with_namespace: 'acme/backend',
      visibility: 'private',
    } satisfies GitLabProject;

    const values = buildGitLabRepositoryValues({
      project,
      linkedByUserId: 'user-1',
      baseUrl: 'https://gitlab.example.com',
    });

    expect(values.cloneUrl).toBe('https://gitlab.example.com/acme/backend.git');
    expect(values.htmlUrl).toBe('https://gitlab.example.com/acme/backend');
  });
});

describe('createTaskRunScopedGitLabTokens', () => {
  const originalGitLabBaseUrl = process.env.GITLAB_BASE_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitLabOAuthAccessToken.mockResolvedValue('oauth_access_token');
    delete process.env.GITLAB_BASE_URL;
    mockEnvironmentVariablesFindMany.mockResolvedValue([]);
    mockEnvironmentsFindFirst.mockResolvedValue(null);
    mockRepositoriesFindMany.mockResolvedValue([
      {
        fullName: 'group/project',
        externalRepoId: '42',
      },
    ]);
  });

  afterEach(() => {
    if (originalGitLabBaseUrl === undefined) {
      delete process.env.GITLAB_BASE_URL;
    } else {
      process.env.GITLAB_BASE_URL = originalGitLabBaseUrl;
    }
  });

  it('mints repo-scoped project access tokens for selected GitLab repositories', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 999,
          token: 'glptt_repo_scoped',
          username: 'oauth2',
        }),
        { status: 201 },
      ),
    );

    const result = await createTaskRunScopedGitLabTokens(
      makeTaskRun({
        repo: 'group/project',
        description: 'Work on GitLab',
        sourceControlProvider: 'gitlab',
      }),
      { fetchImpl: fetchMock },
    );

    expect(result).toEqual({
      credentials: [
        {
          host: 'gitlab.com',
          originBaseUrl: 'https://gitlab.com',
          repositoryFullName: 'group/project',
          username: 'oauth2',
          token: 'glptt_repo_scoped',
        },
      ],
      proxyCredentials: [],
      artifactsPatch: {
        gitlabScopedProjectTokens: [
          {
            repositoryFullName: 'group/project',
            projectId: '42',
            tokenId: 999,
          },
        ],
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects/42/access_tokens',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'PRIVATE-TOKEN': 'oauth_access_token',
          'Content-Type': 'application/json',
        }),
        body: expect.stringContaining('"write_repository"'),
      }),
    );
  });

  it('mints scoped tokens against a self-managed GITLAB_BASE_URL with the self-managed credential host', async () => {
    process.env.GITLAB_BASE_URL = 'https://gitlab.example.com';

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 999,
          token: 'glptt_repo_scoped',
          username: 'oauth2',
        }),
        { status: 201 },
      ),
    );

    const result = await createTaskRunScopedGitLabTokens(
      makeTaskRun({
        repo: 'group/project',
        description: 'Work on self-managed GitLab',
        sourceControlProvider: 'gitlab',
      }),
      { fetchImpl: fetchMock },
    );

    expect(result.credentials[0]?.host).toBe('gitlab.example.com');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gitlab.example.com/api/v4/projects/42/access_tokens',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('rotates persisted repo-scoped tokens when they already exist', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 321,
          token: 'glptt_rotated',
          username: 'oauth2',
        }),
        { status: 200 },
      ),
    );

    const result = await createTaskRunScopedGitLabTokens(
      {
        ...makeTaskRun({
          repo: 'group/project',
          description: 'Resume GitLab job',
          sourceControlProvider: 'gitlab',
        }),
        artifacts: {
          gitlabScopedProjectTokens: [
            {
              repositoryFullName: 'group/project',
              projectId: '42',
              tokenId: 123,
            },
          ],
        },
      },
      { fetchImpl: fetchMock },
    );

    expect(result.credentials[0]?.token).toBe('glptt_rotated');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects/42/access_tokens/123/rotate',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('revokes deselected repo-scoped tokens before rotating the active scope', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 321,
            token: 'glptt_rotated',
            username: 'oauth2',
          }),
          { status: 200 },
        ),
      );

    const result = await createTaskRunScopedGitLabTokens(
      {
        ...makeTaskRun({
          repo: 'group/project',
          description: 'Refresh GitLab job',
          sourceControlProvider: 'gitlab',
          selectedRepositories: ['group/project'],
        }),
        artifacts: {
          gitlabScopedProjectTokens: [
            {
              repositoryFullName: 'group/project',
              projectId: '42',
              tokenId: 123,
            },
            {
              repositoryFullName: 'group/removed',
              projectId: '77',
              tokenId: 456,
            },
          ],
        },
      },
      { fetchImpl: fetchMock },
    );

    expect(result.artifactsPatch).toEqual({
      gitlabScopedProjectTokens: [
        {
          repositoryFullName: 'group/project',
          projectId: '42',
          tokenId: 321,
        },
      ],
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://gitlab.com/api/v4/projects/77/access_tokens/456',
      expect.objectContaining({
        method: 'DELETE',
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://gitlab.com/api/v4/projects/42/access_tokens/123/rotate',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  it('stops before rotating active tokens when stale-token revocation fails during a scope shrink', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 500, statusText: 'Server Error' }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 321,
            token: 'glptt_rotated',
            username: 'oauth2',
          }),
          { status: 200 },
        ),
      );

    await expect(
      createTaskRunScopedGitLabTokens(
        {
          ...makeTaskRun({
            repo: 'group/project',
            description: 'Resume GitLab job',
            sourceControlProvider: 'gitlab',
            selectedRepositories: ['group/project'],
          }),
          artifacts: {
            gitlabScopedProjectTokens: [
              {
                repositoryFullName: 'group/project',
                projectId: '42',
                tokenId: 123,
              },
              {
                repositoryFullName: 'group/removed',
                projectId: '77',
                tokenId: 456,
              },
            ],
          },
        },
        { fetchImpl: fetchMock },
      ),
    ).rejects.toThrow(
      'Failed to revoke GitLab scoped tokens for repositories: group/removed',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cleans up newly minted tokens when token issuance fails after stale-token revocation succeeds', async () => {
    mockRepositoriesFindMany.mockResolvedValue([
      {
        fullName: 'group/project',
        externalRepoId: '42',
      },
      {
        fullName: 'group/second',
        externalRepoId: '84',
      },
    ]);

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 321,
            token: 'glptt_first',
            username: 'oauth2',
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(null, { status: 500, statusText: 'Server Error' }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(
      createTaskRunScopedGitLabTokens(
        {
          ...makeTaskRun({
            repo: 'group/project',
            description: 'Resume GitLab job',
            sourceControlProvider: 'gitlab',
            selectedRepositories: ['group/project', 'group/second'],
          }),
          artifacts: {
            gitlabScopedProjectTokens: [
              {
                repositoryFullName: 'group/removed',
                projectId: '77',
                tokenId: 456,
              },
            ],
          },
        },
        { fetchImpl: fetchMock },
      ),
    ).rejects.toThrow('GitLab API request failed: 500 Server Error');

    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      'https://gitlab.com/api/v4/projects/42/access_tokens/321',
      expect.objectContaining({
        method: 'DELETE',
      }),
    );
  });

  it('falls back to deployment-token proxy credentials when the token cannot mint project access tokens', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: 'permission denied' }), {
        status: 400,
        statusText: 'Bad Request',
      }),
    );

    const result = await createTaskRunScopedGitLabTokens(
      makeTaskRun({
        repo: 'group/project',
        description: 'Work on GitLab',
        sourceControlProvider: 'gitlab',
      }),
      { fetchImpl: fetchMock },
    );

    expect(result).toEqual({
      credentials: [],
      proxyCredentials: [
        {
          host: 'gitlab.com',
          originBaseUrl: 'https://gitlab.com',
          repositoryFullName: 'group/project',
          username: 'oauth2',
          token: 'oauth_access_token',
        },
      ],
      artifactsPatch: {
        gitlabScopedProjectTokens: [],
      },
    });
  });

  it('revokes already minted tokens before falling back when a later mint hits a permission error', async () => {
    mockRepositoriesFindMany.mockResolvedValue([
      {
        fullName: 'group/project',
        externalRepoId: '42',
      },
      {
        fullName: 'group/second',
        externalRepoId: '84',
      },
    ]);

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 321,
            token: 'glptt_first',
            username: 'oauth2',
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'permission denied' }), {
          status: 403,
          statusText: 'Forbidden',
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await createTaskRunScopedGitLabTokens(
      makeTaskRun({
        repo: 'group/project',
        description: 'Work on GitLab',
        sourceControlProvider: 'gitlab',
        selectedRepositories: ['group/project', 'group/second'],
      }),
      { fetchImpl: fetchMock },
    );

    expect(result.credentials).toEqual([]);
    expect(
      result.proxyCredentials.map(
        (credential) => credential.repositoryFullName,
      ),
    ).toEqual(['group/project', 'group/second']);
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://gitlab.com/api/v4/projects/42/access_tokens/321',
      expect.objectContaining({
        method: 'DELETE',
      }),
    );
  });

  it('does not fall back when the deployment token itself fails to authenticate', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: '401 Unauthorized' }), {
        status: 401,
        statusText: 'Unauthorized',
      }),
    );

    await expect(
      createTaskRunScopedGitLabTokens(
        makeTaskRun({
          repo: 'group/project',
          description: 'Work on GitLab',
          sourceControlProvider: 'gitlab',
        }),
        { fetchImpl: fetchMock },
      ),
    ).rejects.toThrow('GitLab API request failed: 401 Unauthorized');
  });

  it('rejects true all-repositories GitLab jobs because they are not repo-scoped', async () => {
    await expect(
      createTaskRunScopedGitLabTokens(
        makeTaskRun({
          repo: '__all_repositories__',
          description: 'Unsafe GitLab scope',
          sourceControlProvider: 'gitlab',
        }),
      ),
    ).rejects.toThrow(
      'GitLab source control jobs require an explicit repository scope for task run 123.',
    );
  });
});

describe('getGitLabDeploymentUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearGitLabDeploymentUserCache();
    mockGitLabOAuthAccessToken.mockResolvedValue('oauth_access_token');
  });

  afterEach(() => {
    clearGitLabDeploymentUserCache();
  });

  it('resolves the deployment identity via GET /user and caches it', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 99, username: 'roomote-bot' }), {
        status: 200,
      }),
    );

    const first = await getGitLabDeploymentUser({ fetchImpl: fetchMock });
    const second = await getGitLabDeploymentUser({ fetchImpl: fetchMock });

    expect(first).toEqual({ id: 99, username: 'roomote-bot' });
    expect(second).toEqual({ id: 99, username: 'roomote-bot' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/user',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'PRIVATE-TOKEN': 'oauth_access_token',
        }),
      }),
    );
  });

  it('returns null when no GitLab OAuth connection is configured', async () => {
    mockGitLabOAuthAccessToken.mockResolvedValue(null);
    const fetchMock = vi.fn<typeof fetch>();

    await expect(
      getGitLabDeploymentUser({ fetchImpl: fetchMock }),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('createGitLabMergeRequestNote', () => {
  it('posts a note to the merge request notes endpoint', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 4321 }), { status: 201 }),
      );

    const result = await createGitLabMergeRequestNote({
      projectId: '42',
      mergeRequestIid: 7,
      body: 'On it!',
      token: 'glpat_deployment_token',
      fetchImpl: fetchMock,
    });

    expect(result).toEqual({ id: 4321 });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects/42/merge_requests/7/notes',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'PRIVATE-TOKEN': 'glpat_deployment_token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ body: 'On it!' }),
      }),
    );
  });

  it('requires a token', async () => {
    await expect(
      createGitLabMergeRequestNote({
        projectId: '42',
        mergeRequestIid: 7,
        body: 'hi',
        token: '',
        fetchImpl: vi.fn<typeof fetch>(),
      }),
    ).rejects.toThrow(
      'GitLab OAuth authorization is required to create merge request notes.',
    );
  });
});

describe('ensureGitLabWebhooksForProjects', () => {
  it('creates missing webhooks and refreshes existing ones by URL', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      // project 42: no hooks yet -> create
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      // project 84: hook already exists -> update
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { id: 5, url: 'https://roomote.example.com/api/webhooks/gitlab' },
          ]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 6,
            url: 'https://roomote.example.com/api/webhooks/gitlab',
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 5,
            url: 'https://roomote.example.com/api/webhooks/gitlab',
          }),
          { status: 200 },
        ),
      );

    const results = await ensureGitLabWebhooksForProjects({
      projects: [
        { projectId: '42', repositoryFullName: 'group/project' },
        { projectId: '84', repositoryFullName: 'group/second' },
      ],
      webhookUrl: 'https://roomote.example.com/api/webhooks/gitlab',
      secretToken: 'webhook-secret',
      token: 'glpat_test',
      fetchImpl: fetchMock,
    });

    expect(results).toEqual([
      { repositoryFullName: 'group/project', status: 'created' },
      { repositoryFullName: 'group/second', status: 'updated' },
    ]);

    const createCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === 'https://gitlab.com/api/v4/projects/42/hooks' &&
        init?.method === 'POST',
    );
    expect(createCall?.[1]?.body).toContain('"merge_requests_events":true');
    expect(createCall?.[1]?.body).toContain('"token":"webhook-secret"');

    const updateCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === 'PUT',
    );
    expect(updateCall?.[0]).toBe(
      'https://gitlab.com/api/v4/projects/84/hooks/5',
    );
  });

  it('finds an existing hook beyond the first page instead of creating a duplicate', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ id: 1, url: 'https://other.example.com/hook' }]),
          { status: 200, headers: { 'x-next-page': '2' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { id: 5, url: 'https://roomote.example.com/api/webhooks/gitlab' },
          ]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 5,
            url: 'https://roomote.example.com/api/webhooks/gitlab',
          }),
          { status: 200 },
        ),
      );

    const results = await ensureGitLabWebhooksForProjects({
      projects: [{ projectId: '42', repositoryFullName: 'group/project' }],
      webhookUrl: 'https://roomote.example.com/api/webhooks/gitlab',
      secretToken: 'webhook-secret',
      token: 'glpat_test',
      fetchImpl: fetchMock,
    });

    expect(results).toEqual([
      { repositoryFullName: 'group/project', status: 'updated' },
    ]);
    expect(fetchMock.mock.calls[1]?.[0]).toContain('page=2');
    expect(fetchMock.mock.calls[2]?.[1]?.method).toBe('PUT');
  });

  it('collects per-project failures without failing the batch', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ message: '403 Forbidden' }), {
        status: 403,
        statusText: 'Forbidden',
      }),
    );

    const results = await ensureGitLabWebhooksForProjects({
      projects: [{ projectId: '42', repositoryFullName: 'group/project' }],
      webhookUrl: 'https://roomote.example.com/api/webhooks/gitlab',
      secretToken: 'webhook-secret',
      token: 'glpat_test',
      fetchImpl: fetchMock,
    });

    expect(results).toEqual([
      {
        repositoryFullName: 'group/project',
        status: 'failed',
        error: 'GitLab API request failed: 403 Forbidden',
      },
    ]);
  });
});

describe('removeGitLabWebhooksForProjects', () => {
  it('removes the Roomote webhook and reports not_found when absent', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      // project 42: our hook exists -> delete it
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { id: 5, url: 'https://roomote.example.com/api/webhooks/gitlab' },
          ]),
          { status: 200 },
        ),
      )
      // project 84: only unrelated hooks -> nothing to remove
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ id: 9, url: 'https://other.example.com/hook' }]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const results = await removeGitLabWebhooksForProjects({
      projects: [
        { projectId: '42', repositoryFullName: 'group/project' },
        { projectId: '84', repositoryFullName: 'group/second' },
      ],
      webhookUrl: 'https://roomote.example.com/api/webhooks/gitlab',
      token: 'glpat_test',
      fetchImpl: fetchMock,
    });

    expect(results).toEqual([
      { repositoryFullName: 'group/project', status: 'removed' },
      { repositoryFullName: 'group/second', status: 'not_found' },
    ]);

    const deleteCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === 'DELETE',
    );
    expect(deleteCall?.[0]).toBe(
      'https://gitlab.com/api/v4/projects/42/hooks/5',
    );
  });

  it('collects per-project failures without failing the batch', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ message: '403 Forbidden' }), {
        status: 403,
        statusText: 'Forbidden',
      }),
    );

    const results = await removeGitLabWebhooksForProjects({
      projects: [{ projectId: '42', repositoryFullName: 'group/project' }],
      webhookUrl: 'https://roomote.example.com/api/webhooks/gitlab',
      token: 'glpat_test',
      fetchImpl: fetchMock,
    });

    expect(results).toEqual([
      {
        repositoryFullName: 'group/project',
        status: 'failed',
        error: 'GitLab API request failed: 403 Forbidden',
      },
    ]);
  });
});

describe('revokeGitLabScopedProjectToken', () => {
  it('accepts a 204 delete response', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));

    await expect(
      revokeGitLabScopedProjectToken({
        projectId: '42',
        tokenId: 99,
        token: 'glpat_deployment_token',
        fetchImpl: fetchMock,
      }),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects/42/access_tokens/99',
      expect.objectContaining({
        method: 'DELETE',
      }),
    );
  });
});
