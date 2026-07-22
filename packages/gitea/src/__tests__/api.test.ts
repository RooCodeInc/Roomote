import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { RunStatus, TaskPayloadKind } from '@roomote/types';
import type { TaskRun } from '@roomote/db/server';

const {
  mockEnvironmentVariablesFindMany,
  mockRepositoriesFindMany,
  mockEnvironmentsFindFirst,
  mockGetGiteaOAuthConnection,
  mockResolveGiteaOAuthAccessToken,
} = vi.hoisted(() => ({
  mockEnvironmentVariablesFindMany: vi.fn(),
  mockRepositoriesFindMany: vi.fn(),
  mockEnvironmentsFindFirst: vi.fn(),
  mockGetGiteaOAuthConnection: vi.fn(),
  mockResolveGiteaOAuthAccessToken: vi.fn(),
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

vi.mock('../oauth', async () => {
  const actual = await vi.importActual<typeof import('../oauth')>('../oauth');

  return {
    ...actual,
    getGiteaOAuthConnection: (...args: unknown[]) =>
      mockGetGiteaOAuthConnection(...args),
    resolveGiteaOAuthAccessToken: (...args: unknown[]) =>
      mockResolveGiteaOAuthAccessToken(...args),
  };
});

import {
  buildGiteaApiBaseUrl,
  normalizeGiteaBaseUrl,
  buildGiteaRepositoryValues,
  createTaskRunGiteaCredentials,
  createGiteaPullRequestComment,
  createGiteaIssueComment,
  ensureGiteaWebhooksForRepositories,
  removeGiteaWebhooksForRepositories,
  getGiteaAuthenticatedUser,
  getGiteaDeploymentUser,
  clearGiteaDeploymentUserCache,
  getGiteaActionRunConclusion,
  getGiteaActionRunFailureEvidence,
  getGiteaWorkflowName,
  getLatestGiteaActionRun,
  isGiteaActionRunFailed,
  listGiteaRepositories,
  resolveGiteaInstanceHost,
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
  const originalGiteaBaseUrl = process.env.GITEA_BASE_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    clearGiteaDeploymentUserCache();
    process.env.GITEA_BASE_URL = 'https://git.example.com/';
    mockEnvironmentVariablesFindMany.mockResolvedValue([]);
    mockEnvironmentsFindFirst.mockResolvedValue(null);
    mockRepositoriesFindMany.mockResolvedValue([
      {
        fullName: 'acme/backend',
      },
    ]);
    mockGetGiteaOAuthConnection.mockResolvedValue(null);
    mockResolveGiteaOAuthAccessToken.mockResolvedValue(null);
  });

  afterEach(() => {
    if (originalGiteaBaseUrl === undefined) {
      delete process.env.GITEA_BASE_URL;
    } else {
      process.env.GITEA_BASE_URL = originalGiteaBaseUrl;
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
    expect(normalizeGiteaBaseUrl('gitea.com')).toBe('https://gitea.com');
    expect(normalizeGiteaBaseUrl('git.example.com/')).toBe(
      'https://git.example.com',
    );
    expect(normalizeGiteaBaseUrl('git.example.com////////')).toBe(
      'https://git.example.com',
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
          Authorization: 'Bearer gitea_test',
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
    ).rejects.toThrow(
      'Gitea OAuth connection is required to sync repositories.',
    );

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
          Authorization: 'Bearer gitea_test',
        }),
      }),
    );
  });

  it('returns the OAuth connection identity when /user is unavailable', async () => {
    mockGetGiteaOAuthConnection.mockResolvedValue({
      baseUrl: 'https://git.example.com',
      clientId: 'client',
      clientSecret: 'secret',
      accountId: '99',
      username: 'ci-agent',
      accessToken: 'token',
      refreshToken: 'refresh',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      scopes: [],
      status: 'active',
    });
    mockResolveGiteaOAuthAccessToken.mockResolvedValue(null);

    await expect(getGiteaDeploymentUser()).resolves.toEqual({
      id: 99,
      login: 'ci-agent',
    });
  });

  it('resolves deployment user via /user and preserves connection id when needed', async () => {
    mockGetGiteaOAuthConnection.mockResolvedValue({
      baseUrl: 'https://git.example.com',
      clientId: 'client',
      clientSecret: 'secret',
      accountId: '99',
      username: 'ci-agent',
      accessToken: 'token',
      refreshToken: 'refresh',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      scopes: [],
      status: 'active',
    });
    mockResolveGiteaOAuthAccessToken.mockResolvedValue('gitea_live_token');

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ login: 'ci-agent' }), {
        status: 200,
      }),
    );

    await expect(
      getGiteaDeploymentUser({ fetchImpl: fetchMock }),
    ).resolves.toEqual({
      id: 99,
      login: 'ci-agent',
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
          Authorization: 'Bearer gitea_test',
          'Content-Type': 'application/json',
        }),
        body: expect.stringContaining('"pull_request_sync"'),
      }),
    );
    expect(fetchMock.mock.calls[1]?.[1]?.body).toContain('"issues"');
    expect(fetchMock.mock.calls[1]?.[1]?.body).toContain('"workflow_run"');
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

  it('posts a plain Gitea issue comment through the issue comments API', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 56 }), {
        status: 201,
      }),
    );

    await expect(
      createGiteaIssueComment({
        repositoryFullName: 'acme/backend',
        issueNumber: 77,
        body: 'I started a task for this issue.',
        token: 'gitea_test',
        baseUrl: 'https://git.example.com',
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual({ id: 56 });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://git.example.com/api/v1/repos/acme/backend/issues/77/comments',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ body: 'I started a task for this issue.' }),
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
      { username: 'roomote-bot', token: 'gitea_oauth_token' },
    );

    expect(result).toEqual({
      credentials: [
        {
          host: 'git.example.com',
          repositoryFullName: 'acme/backend',
          username: 'roomote-bot',
          token: 'gitea_oauth_token',
          originBaseUrl: 'https://git.example.com',
        },
      ],
    });
  });

  it('resolves the deployment Gitea instance host from GITEA_BASE_URL', async () => {
    await expect(resolveGiteaInstanceHost()).resolves.toBe('git.example.com');
  });

  it('reads the latest Gitea Actions run for a branch tip', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          total_count: 1,
          workflow_runs: [
            {
              id: 99,
              status: 'completed',
              conclusion: 'failure',
              head_branch: 'main',
              head_sha: 'abc123',
              path: 'ci.yml@refs/heads/main',
              html_url: 'https://git.example.com/acme/backend/actions/runs/99',
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const latest = await getLatestGiteaActionRun({
      repositoryFullName: 'acme/backend',
      branch: 'main',
      token: 'gitea_test',
      baseUrl: 'https://git.example.com',
      fetchImpl: fetchMock,
    });

    expect(latest).toMatchObject({ id: 99, conclusion: 'failure' });
    expect(getGiteaActionRunConclusion(latest!)).toBe('failure');
    expect(isGiteaActionRunFailed(getGiteaActionRunConclusion(latest!))).toBe(
      true,
    );
    expect(getGiteaWorkflowName(latest!)).toBe('ci.yml');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      '/repos/acme/backend/actions/runs?',
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('branch=main');
  });

  it('falls back to /actions/tasks when /actions/runs is missing (Gitea ≤1.24)', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            total_count: 2,
            entries: [
              {
                id: 10,
                name: 'other.yml',
                status: 'success',
                head_branch: 'develop',
                head_sha: 'sha-other',
                run_number: 1,
                url: 'https://git.example.com/acme/backend/actions/runs/10',
              },
              {
                id: 11,
                name: 'ci.yml',
                status: 'failure',
                head_branch: 'refs/heads/main',
                head_sha: 'sha-main',
                run_number: 2,
                display_title: 'CI',
                url: 'https://git.example.com/acme/backend/actions/runs/11',
              },
            ],
          }),
          { status: 200 },
        ),
      );

    const latest = await getLatestGiteaActionRun({
      repositoryFullName: 'acme/backend',
      branch: 'main',
      token: 'gitea_test',
      baseUrl: 'https://git.example.com',
      fetchImpl: fetchMock,
    });

    expect(latest).toMatchObject({
      id: 11,
      head_sha: 'sha-main',
      conclusion: 'failure',
      html_url: 'https://git.example.com/acme/backend/actions/runs/11',
      path: 'ci.yml',
    });
    expect(getGiteaActionRunConclusion(latest!)).toBe('failure');
    expect(getGiteaWorkflowName(latest!)).toBe('ci.yml');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/actions/runs?');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/actions/tasks?');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('limit=50');
  });

  it('prefers workflow_id over job name on Gitea ≤1.24 tasks payloads', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            total_count: 1,
            workflow_runs: [
              {
                id: 1,
                name: 'build',
                workflow_id: 'ci.yml',
                status: 'failure',
                head_branch: 'main',
                head_sha: 'sha-main',
                run_number: 1,
                display_title: 'CI failed',
                url: 'https://git.example.com/acme/backend/actions/runs/1',
              },
            ],
          }),
          { status: 200 },
        ),
      );

    const latest = await getLatestGiteaActionRun({
      repositoryFullName: 'acme/backend',
      branch: 'main',
      token: 'gitea_test',
      baseUrl: 'https://git.example.com',
      fetchImpl: fetchMock,
    });

    expect(latest).toMatchObject({
      id: 1,
      path: 'ci.yml',
      workflow_id: 'ci.yml',
      name: 'build',
      conclusion: 'failure',
    });
    expect(getGiteaWorkflowName(latest!)).toBe('ci.yml');
  });

  it('treats error conclusion/status as a failed Actions outcome', () => {
    expect(isGiteaActionRunFailed('error')).toBe(true);
    expect(isGiteaActionRunFailed('failure')).toBe(true);
    expect(isGiteaActionRunFailed('failed')).toBe(true);
    expect(isGiteaActionRunFailed('success')).toBe(false);
    expect(
      isGiteaActionRunFailed(
        getGiteaActionRunConclusion({
          id: 1,
          status: 'error',
          conclusion: null,
        }),
      ),
    ).toBe(true);
  });

  it('builds Actions failure evidence from failed jobs and log tails', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            total_count: 2,
            jobs: [
              {
                id: 7,
                name: 'test',
                status: 'completed',
                conclusion: 'failure',
              },
              {
                id: 8,
                name: 'lint',
                status: 'completed',
                conclusion: 'success',
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response('line1\nAssertionError: boom\n', { status: 200 }),
      );

    const evidence = await getGiteaActionRunFailureEvidence({
      repositoryFullName: 'acme/backend',
      runId: 99,
      token: 'gitea_test',
      baseUrl: 'https://git.example.com',
      fetchImpl: fetchMock,
    });

    expect(evidence).toContain('job="test"');
    expect(evidence).toContain('AssertionError: boom');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      '/repos/acme/backend/actions/jobs/7/logs',
    );
  });

  it('falls back to flat /actions/jobs and treats error conclusions as failed', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            total_count: 2,
            jobs: [
              {
                id: 21,
                name: 'unit',
                status: 'completed',
                conclusion: 'error',
                run_id: 99,
              },
              {
                id: 22,
                name: 'other-run',
                status: 'completed',
                conclusion: 'failure',
                run_id: 100,
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response('Error: step failed\n', { status: 200 }),
      );

    const evidence = await getGiteaActionRunFailureEvidence({
      repositoryFullName: 'acme/backend',
      runId: 99,
      token: 'gitea_test',
      baseUrl: 'https://git.example.com',
      fetchImpl: fetchMock,
    });

    expect(evidence).toContain('job="unit"');
    expect(evidence).toContain('conclusion="error"');
    expect(evidence).toContain('Error: step failed');
    expect(evidence).not.toContain('other-run');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      '/actions/runs/99/jobs',
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/actions/jobs?');
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain(
      '/actions/jobs/21/logs',
    );
  });

  it('returns null evidence when jobs cannot be listed', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(new Response('not found', { status: 404 }));

    await expect(
      getGiteaActionRunFailureEvidence({
        repositoryFullName: 'acme/backend',
        runId: 99,
        token: 'gitea_test',
        baseUrl: 'https://git.example.com',
        fetchImpl: fetchMock,
      }),
    ).resolves.toBeNull();
  });

  it('returns null evidence when jobs listing fails with a server error', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('server error', { status: 500, statusText: 'Error' }),
      );

    await expect(
      getGiteaActionRunFailureEvidence({
        repositoryFullName: 'acme/backend',
        runId: 99,
        token: 'gitea_test',
        baseUrl: 'https://git.example.com',
        fetchImpl: fetchMock,
      }),
    ).resolves.toBeNull();
  });
});
