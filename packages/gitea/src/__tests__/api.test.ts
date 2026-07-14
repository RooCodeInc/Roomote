import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { RunStatus, TaskPayloadKind } from '@roomote/types';
import type { TaskRun } from '@roomote/db/server';

const {
  mockEnvironmentVariablesFindMany,
  mockRepositoriesFindMany,
  mockEnvironmentsFindFirst,
} = vi.hoisted(() => ({
  mockEnvironmentVariablesFindMany: vi.fn(),
  mockRepositoriesFindMany: vi.fn(),
  mockEnvironmentsFindFirst: vi.fn(),
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

import {
  buildGiteaApiBaseUrl,
  buildGiteaRepositoryValues,
  createTaskRunGiteaCredentials,
  createGiteaPullRequestComment,
  ensureGiteaWebhooksForRepositories,
  removeGiteaWebhooksForRepositories,
  getGiteaAuthenticatedUser,
  listGiteaRepositories,
  validateGiteaToken,
  type GiteaRepository,
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

describe('Gitea API helpers', () => {
  const originalGiteaToken = process.env.GITEA_TOKEN;
  const originalGiteaBaseUrl = process.env.GITEA_BASE_URL;
  const originalGiteaUsername = process.env.GITEA_USERNAME;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITEA_TOKEN = 'gitea_deployment_token';
    process.env.GITEA_BASE_URL = 'https://git.example.com/';
    delete process.env.GITEA_USERNAME;
    mockEnvironmentVariablesFindMany.mockResolvedValue([]);
    mockEnvironmentsFindFirst.mockResolvedValue(null);
    mockRepositoriesFindMany.mockResolvedValue([
      {
        fullName: 'acme/backend',
      },
    ]);
  });

  afterEach(() => {
    if (originalGiteaToken === undefined) {
      delete process.env.GITEA_TOKEN;
    } else {
      process.env.GITEA_TOKEN = originalGiteaToken;
    }

    if (originalGiteaBaseUrl === undefined) {
      delete process.env.GITEA_BASE_URL;
    } else {
      process.env.GITEA_BASE_URL = originalGiteaBaseUrl;
    }

    if (originalGiteaUsername === undefined) {
      delete process.env.GITEA_USERNAME;
    } else {
      process.env.GITEA_USERNAME = originalGiteaUsername;
    }
  });

  it('builds the API base URL from the configured Gitea instance URL', () => {
    expect(buildGiteaApiBaseUrl('https://git.example.com/')).toBe(
      'https://git.example.com/api/v1',
    );
    expect(buildGiteaApiBaseUrl('https://git.example.com/api/v1')).toBe(
      'https://git.example.com/api/v1',
    );
    expect(buildGiteaApiBaseUrl('https://git.example.com/gitea/api/v1/')).toBe(
      'https://git.example.com/gitea/api/v1',
    );
    expect(buildGiteaApiBaseUrl('https://gitea.com/roocode/')).toBe(
      'https://gitea.com/api/v1',
    );
  });

  it('lists authenticated Gitea repositories with token auth and pagination', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 1,
              name: 'backend',
              full_name: 'acme/backend',
              private: true,
            },
          ]),
          {
            status: 200,
            headers: {
              link: '<https://git.example.com/api/v1/user/repos?page=2&limit=50>; rel="next"',
              'x-total-count': '2',
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 2,
              name: 'web',
              full_name: 'acme/web',
              private: false,
            },
          ]),
          {
            status: 200,
            headers: {
              'x-total-count': '2',
            },
          },
        ),
      );

    const repositories = await listGiteaRepositories({
      baseUrl: 'https://git.example.com',
      fetchImpl: fetchMock,
      token: 'gitea_test',
    });

    expect(repositories.map((repository) => repository.full_name)).toEqual([
      'acme/backend',
      'acme/web',
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://git.example.com/api/v1/user/repos?limit=50&page=1',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'token gitea_test',
        }),
      }),
    );
  });

  it('requires a token and base URL to list repositories', async () => {
    await expect(
      listGiteaRepositories({
        token: '',
        baseUrl: 'https://git.example.com',
      }),
    ).rejects.toThrow('GITEA_TOKEN is required to sync Gitea repositories.');

    await expect(
      listGiteaRepositories({
        token: 'gitea_test',
        baseUrl: '',
      }),
    ).rejects.toThrow('GITEA_BASE_URL is required to sync Gitea repositories.');
  });

  it('maps Gitea repository fields into provider-tagged repository rows', () => {
    const repository = {
      id: 123,
      name: 'backend',
      full_name: 'acme/platform/backend',
      description: 'Backend service',
      private: true,
      default_branch: 'develop',
      clone_url: 'https://git.example.com/acme/platform/backend.git',
      html_url: 'https://git.example.com/acme/platform/backend',
      permissions: { admin: true, push: true, pull: true },
    } satisfies GiteaRepository;

    expect(
      buildGiteaRepositoryValues({
        repository,
        linkedByUserId: 'user-1',
        baseUrl: 'https://git.example.com',
      }),
    ).toEqual({
      sourceControlProvider: 'gitea',
      installationId: null,
      userId: null,
      githubRepoId: null,
      externalRepoId: '123',
      host: 'git.example.com',
      name: 'backend',
      fullName: 'acme/platform/backend',
      description: 'Backend service',
      private: true,
      defaultBranch: 'develop',
      cloneUrl: 'https://git.example.com/acme/platform/backend.git',
      htmlUrl: 'https://git.example.com/acme/platform/backend',
      permissions: { admin: true, push: true, pull: true },
      isActive: true,
      linkedByUserId: 'user-1',
    });
  });

  it('fetches the authenticated Gitea username for git credentials', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ login: 'roomote-bot' }), {
        status: 200,
      }),
    );

    await expect(
      getGiteaAuthenticatedUser({
        token: 'gitea_test',
        baseUrl: 'https://git.example.com',
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual({ login: 'roomote-bot' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://git.example.com/api/v1/user',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'token gitea_test',
        }),
      }),
    );
  });

  it('validates a Gitea token with the authenticated user endpoint', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ login: 'roomote-bot' }), {
        status: 200,
      }),
    );

    await expect(
      validateGiteaToken({
        token: 'gitea_test',
        baseUrl: 'https://git.example.com',
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual({ status: 'valid', login: 'roomote-bot' });
  });

  it('rejects definitively invalid Gitea tokens during validation', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: 'forbidden' }), {
        status: 403,
        statusText: 'Forbidden',
      }),
    );

    await expect(
      validateGiteaToken({
        token: 'bad_token',
        baseUrl: 'https://git.example.com',
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual({
      status: 'invalid',
      error:
        'Gitea rejected the token. Confirm the token is active and has repository access.',
    });
  });

  it('removes the Roomote webhook from repositories and reports not_found when absent', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input, init) => {
        const url = String(input);

        if (init?.method === 'DELETE') {
          return new Response(null, { status: 204 });
        }

        // acme/backend: our hook exists -> delete it
        if (url.includes('/repos/acme/backend/hooks')) {
          return new Response(
            JSON.stringify([
              {
                id: 7,
                type: 'gitea',
                config: {
                  url: 'https://roomote.example.com/api/webhooks/gitea',
                },
              },
            ]),
            { status: 200 },
          );
        }

        // acme/tools: only unrelated hooks -> nothing to remove
        return new Response(
          JSON.stringify([
            {
              id: 9,
              type: 'gitea',
              config: { url: 'https://other.example.com/hook' },
            },
          ]),
          { status: 200 },
        );
      });

    await expect(
      removeGiteaWebhooksForRepositories({
        repositories: [
          { repositoryFullName: 'acme/backend' },
          { repositoryFullName: 'acme/tools' },
        ],
        webhookUrl: 'https://roomote.example.com/api/webhooks/gitea',
        token: 'gitea_test',
        baseUrl: 'https://git.example.com',
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual([
      { repositoryFullName: 'acme/backend', status: 'removed' },
      { repositoryFullName: 'acme/tools', status: 'not_found' },
    ]);

    const deleteCall = fetchMock.mock.calls.find(
      ([, init]) => init?.method === 'DELETE',
    );
    expect(deleteCall?.[0]).toBe(
      'https://git.example.com/api/v1/repos/acme/backend/hooks/7',
    );
  });

  it('collects per-repository webhook removal failures without failing the batch', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'forbidden' }), {
        status: 403,
        statusText: 'Forbidden',
      }),
    );

    await expect(
      removeGiteaWebhooksForRepositories({
        repositories: [{ repositoryFullName: 'acme/backend' }],
        webhookUrl: 'https://roomote.example.com/api/webhooks/gitea',
        token: 'gitea_test',
        baseUrl: 'https://git.example.com',
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual([
      {
        repositoryFullName: 'acme/backend',
        status: 'failed',
        error: 'Gitea API request failed: 403 Forbidden',
      },
    ]);
  });

  it('creates or refreshes Gitea pull request webhooks for repositories', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 7,
            type: 'gitea',
            config: { url: 'https://roomote.example.com/api/webhooks/gitea' },
          }),
          { status: 201 },
        ),
      );

    await expect(
      ensureGiteaWebhooksForRepositories({
        repositories: [{ repositoryFullName: 'acme/backend' }],
        webhookUrl: 'https://roomote.example.com/api/webhooks/gitea',
        secretToken: 'webhook-secret',
        token: 'gitea_test',
        baseUrl: 'https://git.example.com',
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual([
      {
        repositoryFullName: 'acme/backend',
        status: 'created',
      },
    ]);

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://git.example.com/api/v1/repos/acme/backend/hooks',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'token gitea_test',
          'Content-Type': 'application/json',
        }),
        body: expect.stringContaining('"pull_request_sync"'),
      }),
    );
  });

  it('posts a Gitea pull request comment through the issue comments API', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 55 }), {
        status: 201,
      }),
    );

    await expect(
      createGiteaPullRequestComment({
        repositoryFullName: 'acme/backend',
        pullRequestNumber: 42,
        body: 'I started a review.',
        token: 'gitea_test',
        baseUrl: 'https://git.example.com',
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual({ id: 55 });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://git.example.com/api/v1/repos/acme/backend/issues/42/comments',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ body: 'I started a review.' }),
      }),
    );
  });

  it('creates proxy-backed git credentials for selected Gitea repositories', async () => {
    const result = await createTaskRunGiteaCredentials(
      makeTaskRun({
        repo: 'acme/backend',
        description: 'Work on Gitea',
        sourceControlProvider: 'gitea',
      }),
      { username: 'roomote-bot' },
    );

    expect(result).toEqual({
      credentials: [
        {
          host: 'git.example.com',
          repositoryFullName: 'acme/backend',
          username: 'roomote-bot',
          token: 'gitea_deployment_token',
          originBaseUrl: 'https://git.example.com',
        },
      ],
    });
    expect(mockRepositoriesFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        columns: { fullName: true },
      }),
    );
  });
});
