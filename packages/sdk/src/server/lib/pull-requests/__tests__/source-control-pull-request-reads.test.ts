import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RunStatus, TaskPayloadKind } from '@roomote/types';
import type { TaskRun } from '@roomote/db/server';

const {
  mockCreateGitHubToken,
  mockGetOctokit,
  mockRepositoriesFindFirst,
  mockEnvironmentsFindFirst,
  mockResolveGitLabToken,
  mockResolveGiteaToken,
  mockResolveGiteaBaseUrl,
  mockBuildGiteaApiBaseUrl,
  mockResolveAdoToken,
  mockResolveAdoBaseUrl,
  mockBuildAdoOrganizationApiBaseUrl,
  mockGetGitHubRateLimitRetryAfterMs,
} = vi.hoisted(() => ({
  mockCreateGitHubToken: vi.fn(),
  mockGetOctokit: vi.fn(),
  mockRepositoriesFindFirst: vi.fn(),
  mockEnvironmentsFindFirst: vi.fn(),
  mockResolveGitLabToken: vi.fn(),
  mockResolveGiteaToken: vi.fn(),
  mockResolveGiteaBaseUrl: vi.fn(),
  mockBuildGiteaApiBaseUrl: vi.fn(),
  mockResolveAdoToken: vi.fn(),
  mockResolveAdoBaseUrl: vi.fn(),
  mockBuildAdoOrganizationApiBaseUrl: vi.fn(),
  mockGetGitHubRateLimitRetryAfterMs: vi.fn(),
}));

vi.mock('@roomote/auth', () => ({
  createGitHubToken: (...args: unknown[]) => mockCreateGitHubToken(...args),
}));

vi.mock('@roomote/github', () => ({
  getOctokit: (...args: unknown[]) => mockGetOctokit(...args),
  getGitHubRateLimitRetryAfterMs: (...args: unknown[]) =>
    mockGetGitHubRateLimitRetryAfterMs(...args),
  isGitHubUnauthorizedError: (error: unknown) =>
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    Number(error.status) === 401,
}));

vi.mock('@roomote/gitlab', () => ({
  resolveGitLabToken: (...args: unknown[]) => mockResolveGitLabToken(...args),
  isGitLabOAuthAccessToken: (token: string) => token === 'oauth-token',
  resolveGitLabBaseUrl: async () => 'https://gitlab.com',
  buildGitLabApiBaseUrl: (baseUrl: string) =>
    `${baseUrl.replace(/\/+$/, '')}/api/v4`,
}));

vi.mock('@roomote/bitbucket', () => ({
  resolveBitbucketAuth: async () => ({
    token: 'bitbucket-token',
    username: 'bb-bot',
    baseUrl: 'https://bitbucket.org',
    apiBaseUrl: 'https://api.bitbucket.org/2.0',
    authScheme: 'bearer',
  }),
  buildBitbucketApiBaseUrl: () => 'https://api.bitbucket.org/2.0',
}));

vi.mock('@roomote/gitea', () => ({
  resolveGiteaToken: (...args: unknown[]) => mockResolveGiteaToken(...args),
  resolveGiteaBaseUrl: (...args: unknown[]) => mockResolveGiteaBaseUrl(...args),
  buildGiteaApiBaseUrl: (...args: unknown[]) =>
    mockBuildGiteaApiBaseUrl(...args),
}));

vi.mock('@roomote/ado', () => ({
  resolveAdoToken: (...args: unknown[]) => mockResolveAdoToken(...args),
  resolveAdoBaseUrl: (...args: unknown[]) => mockResolveAdoBaseUrl(...args),
  buildAdoOrganizationApiBaseUrl: (...args: unknown[]) =>
    mockBuildAdoOrganizationApiBaseUrl(...args),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      repositories: {
        // resolveRepositoryRow queries with findMany; tests queue a single
        // row (or null), adapted here to the list shape it expects.
        findMany: async (...args: unknown[]) => {
          const row = await mockRepositoriesFindFirst(...args);
          return row == null ? [] : [row];
        },
      },
      environments: {
        findFirst: (...args: unknown[]) => mockEnvironmentsFindFirst(...args),
      },
    },
  },
  repositories: {
    sourceControlProvider: 'repositories.sourceControlProvider',
    fullName: 'repositories.fullName',
    isActive: 'repositories.isActive',
  },
  environments: {
    id: 'environments.id',
  },
  and: vi.fn((...conditions: unknown[]) => ({ type: 'and', conditions })),
  eq: vi.fn((left: unknown, right: unknown) => ({ type: 'eq', left, right })),
}));

import {
  listMergedSourceControlPullRequestsForRepository,
  readSourceControlPullRequestForTaskRun,
  sourceControlPullRequestReadInputSchema,
} from '../source-control-pull-request-reads';
import type { RepositoryRow } from '../source-control-pull-request-shared';

function makeTaskRun(payload: TaskRun['payload']): TaskRun {
  return {
    id: 123,
    status: RunStatus.Dequeued,
    kind: 'fresh',
    payloadKind: TaskPayloadKind.StandardTask,
    taskId: 'task-123',
    actingUserId: 'user-123',
    payload,
    result: null,
    artifacts: null,
  } as TaskRun;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('readSourceControlPullRequestForTaskRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnvironmentsFindFirst.mockResolvedValue(null);
    mockResolveGitLabToken.mockResolvedValue('gitlab-token');
    mockResolveGiteaToken.mockResolvedValue('gitea-token');
    mockResolveGiteaBaseUrl.mockResolvedValue('https://git.example.com');
    mockBuildGiteaApiBaseUrl.mockReturnValue('https://git.example.com/api/v1');
    mockResolveAdoToken.mockResolvedValue('ado-token');
    mockResolveAdoBaseUrl.mockResolvedValue('https://dev.azure.com');
    mockBuildAdoOrganizationApiBaseUrl.mockReturnValue(
      'https://dev.azure.com/acme',
    );
    mockGetGitHubRateLimitRetryAfterMs.mockReturnValue(null);
  });

  it('uses ETags for review-drain GitHub comment polling reads', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: 'installation-etag',
      externalRepoId: null,
      fullName: 'acme/etag-backend',
      htmlUrl: 'https://github.com/acme/etag-backend',
    });
    mockCreateGitHubToken.mockResolvedValue('github-token');
    const notModified = () =>
      Object.assign(new Error('Not modified'), {
        status: 304,
        response: { headers: {} },
      });
    const listReviewComments = vi
      .fn()
      .mockResolvedValueOnce({
        data: [],
        headers: { etag: '"reviews-v1"' },
        status: 200,
      })
      .mockRejectedValueOnce(notModified());
    const listReviews = vi
      .fn()
      .mockResolvedValueOnce({
        data: [],
        headers: { etag: '"pull-reviews-v1"' },
        status: 200,
      })
      .mockRejectedValueOnce(notModified());
    const listComments = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            id: 1,
            user: { login: 'alice' },
            body: 'First page',
            created_at: '2026-08-22T00:00:00Z',
            html_url: null,
          },
        ],
        headers: {
          etag: '"issues-page-1"',
          link: '<https://api.github.com/page=2>; rel="next"',
        },
        status: 200,
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: 2,
            user: { login: 'bob' },
            body: 'Second page',
            created_at: '2026-08-22T00:01:00Z',
            html_url: null,
          },
        ],
        headers: { etag: '"issues-page-2"' },
        status: 200,
      })
      .mockRejectedValueOnce(notModified())
      .mockRejectedValueOnce(notModified());
    const graphql = vi.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });
    mockGetOctokit.mockReturnValue({
      graphql,
      paginate: vi.fn(),
      rest: {
        pulls: { listReviewComments, listReviews },
        issues: { listComments },
      },
    });
    const input = {
      action: 'list_pull_request_comments' as const,
      repositoryFullName: 'acme/etag-backend',
      prNumber: 55,
      sourceControlProvider: 'github' as const,
    };
    const taskRun = makeTaskRun({
      repo: 'acme/etag-backend',
      sourceControlProvider: 'github',
    });

    const cachedResult = await readSourceControlPullRequestForTaskRun({
      taskRun,
      input,
      useGitHubConditionalRequests: true,
    });
    await readSourceControlPullRequestForTaskRun({
      taskRun,
      input,
      useGitHubConditionalRequests: true,
    });

    expect(listReviewComments).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        request: { headers: { 'if-none-match': '"reviews-v1"' } },
      }),
    );
    expect(listReviews).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        request: { headers: { 'if-none-match': '"pull-reviews-v1"' } },
      }),
    );
    expect(listComments).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        page: 1,
        request: { headers: { 'if-none-match': '"issues-page-1"' } },
      }),
    );
    expect(listComments).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        page: 2,
        request: { headers: { 'if-none-match': '"issues-page-2"' } },
      }),
    );
    expect(
      'issueComments' in cachedResult && cachedResult.issueComments,
    ).toEqual([
      expect.objectContaining({ id: '1' }),
      expect.objectContaining({ id: '2' }),
    ]);
  });

  it('reads GitHub pull request details through the installation token', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: 'installation-1',
      externalRepoId: null,
      fullName: 'acme/backend',
      htmlUrl: 'https://github.com/acme/backend',
    });
    mockCreateGitHubToken.mockResolvedValue('github-token');
    const pullsGet = vi.fn().mockResolvedValue({
      data: {
        number: 55,
        html_url: 'https://github.com/acme/backend/pull/55',
        title: '[Fix] Read surface',
        body: 'PR body',
        state: 'closed',
        merged_at: '2026-07-01T00:00:00Z',
        draft: false,
        mergeable: null,
        mergeable_state: 'unknown',
        head: {
          ref: 'codex/read-surface',
          sha: 'head-sha',
          repo: { full_name: 'forker/backend' },
        },
        base: {
          ref: 'develop',
          sha: 'base-sha',
          repo: { full_name: 'acme/backend' },
        },
        user: { login: 'octocat' },
      },
    });
    mockGetOctokit.mockReturnValue({
      rest: { pulls: { get: pullsGet } },
    });

    const result = await readSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/backend',
        sourceControlProvider: 'github',
      }),
      input: {
        action: 'get_pull_request',
        repositoryFullName: 'acme/backend',
        prNumber: 55,
        sourceControlProvider: 'github',
      },
    });

    expect(mockCreateGitHubToken).toHaveBeenCalledWith({
      type: 'installationId',
      installationId: 'installation-1',
    });
    expect(mockGetOctokit).toHaveBeenCalledWith('github-token');
    expect(pullsGet).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'backend',
      pull_number: 55,
    });
    expect(result).toMatchObject({
      success: true,
      provider: 'github',
      repositoryFullName: 'acme/backend',
      number: 55,
      url: 'https://github.com/acme/backend/pull/55',
      title: '[Fix] Read surface',
      body: 'PR body',
      state: 'merged',
      draft: false,
      sourceBranch: 'codex/read-surface',
      targetBranch: 'develop',
      headSha: 'head-sha',
      baseSha: 'base-sha',
      author: 'octocat',
      mergeable: null,
      mergeStateDescription: 'unknown',
      isCrossRepository: true,
      headRepositoryFullName: 'forker/backend',
      warnings: [],
    });
  });

  it('reads a GitLab merge request in a GitHub-primary mixed task', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: null,
      externalRepoId: '101',
      fullName: 'acme/backend',
      htmlUrl: 'https://gitlab.com/acme/backend',
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        iid: 42,
        title: 'Draft: Provider neutral reads',
        description: 'MR body',
        state: 'opened',
        web_url: 'https://gitlab.com/acme/backend/-/merge_requests/42',
        draft: true,
        source_branch: 'codex/read-surface',
        target_branch: 'develop',
        has_conflicts: true,
        merge_status: 'cannot_be_merged',
        detailed_merge_status: 'conflict',
        source_project_id: 101,
        target_project_id: 101,
        sha: 'fallback-sha',
        diff_refs: { base_sha: 'base-sha', head_sha: 'head-sha' },
        author: { username: 'gitlab-user' },
      }),
    );

    const result = await readSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/frontend',
        selectedRepositories: ['acme/frontend', 'acme/backend'],
        sourceControlProvider: 'github',
        repositoryProviders: { 'acme/backend': 'gitlab' },
      } as unknown as TaskRun['payload']),
      input: {
        action: 'get_pull_request',
        repositoryFullName: 'acme/backend',
        prNumber: 42,
      },
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects/101/merge_requests/42',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ 'PRIVATE-TOKEN': 'gitlab-token' }),
      }),
    );
    expect(result).toMatchObject({
      success: true,
      provider: 'gitlab',
      repositoryFullName: 'acme/backend',
      number: 42,
      url: 'https://gitlab.com/acme/backend/-/merge_requests/42',
      title: 'Draft: Provider neutral reads',
      body: 'MR body',
      state: 'open',
      draft: true,
      sourceBranch: 'codex/read-surface',
      targetBranch: 'develop',
      headSha: 'head-sha',
      baseSha: 'base-sha',
      author: 'gitlab-user',
      mergeable: false,
      mergeStateDescription: 'conflict',
      isCrossRepository: false,
      headRepositoryFullName: null,
    });
  });

  it('maps Azure DevOps merge conflicts and fork sources in details', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: null,
      externalRepoId: 'repo-uuid',
      fullName: 'acme/Platform/backend',
      htmlUrl: 'https://dev.azure.com/acme/Platform/_git/backend',
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        pullRequestId: 7,
        title: '[Fix] Read surface',
        description: 'PR body',
        status: 'active',
        isDraft: false,
        mergeStatus: 'conflicts',
        forkSource: { repository: { name: 'backend-fork' } },
        sourceRefName: 'refs/heads/codex/read-surface',
        targetRefName: 'refs/heads/develop',
        lastMergeSourceCommit: { commitId: 'head-sha' },
        lastMergeTargetCommit: { commitId: 'base-sha' },
        createdBy: { displayName: 'Author' },
      }),
    );

    const result = await readSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/Platform/backend',
        sourceControlProvider: 'ado',
      }),
      input: {
        action: 'get_pull_request',
        repositoryFullName: 'acme/Platform/backend',
        prNumber: 7,
        sourceControlProvider: 'ado',
      },
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://dev.azure.com/acme/Platform/_apis/git/repositories/repo-uuid/pullrequests/7?api-version=7.1',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result).toMatchObject({
      success: true,
      provider: 'ado',
      repositoryFullName: 'acme/Platform/backend',
      number: 7,
      state: 'open',
      sourceBranch: 'codex/read-surface',
      targetBranch: 'develop',
      headSha: 'head-sha',
      baseSha: 'base-sha',
      author: 'Author',
      mergeable: false,
      mergeStateDescription: 'conflicts',
      isCrossRepository: true,
      headRepositoryFullName: 'backend-fork',
    });
  });

  it('keeps outdated GitHub review threads anchored on their original line', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: 'installation-1',
      externalRepoId: null,
      fullName: 'acme/backend',
      htmlUrl: 'https://github.com/acme/backend',
    });
    mockCreateGitHubToken.mockResolvedValue('github-token');
    const graphql = vi.fn().mockResolvedValue({
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: 'PRRT_live',
                isResolved: false,
                isOutdated: false,
                path: 'src/index.ts',
                line: 12,
                originalLine: 12,
                comments: {
                  nodes: [
                    {
                      databaseId: 1,
                      author: { login: 'review-bot[bot]' },
                      body: 'Missing error handling here.',
                      createdAt: '2026-08-01T00:00:00Z',
                      url: null,
                    },
                  ],
                },
              },
              {
                id: 'PRRT_outdated',
                isResolved: false,
                isOutdated: true,
                path: 'src/index.ts',
                line: null,
                originalLine: 42,
                comments: {
                  nodes: [
                    {
                      databaseId: 2,
                      author: { login: 'review-bot[bot]' },
                      body: 'This comparison uses the wrong field.',
                      createdAt: '2026-08-01T00:00:00Z',
                      url: null,
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const listReviewComments = vi.fn();
    const listComments = vi.fn();
    const listReviews = vi.fn();
    mockGetOctokit.mockReturnValue({
      graphql,
      paginate: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: 900,
            user: { login: 'roomote-dev[bot]' },
            state: 'CHANGES_REQUESTED',
            body: 'Please address the findings.',
            submitted_at: '2026-08-01T00:00:00Z',
            html_url:
              'https://github.com/acme/backend/pull/55#pullrequestreview-900',
          },
        ]),
      rest: {
        pulls: { listReviewComments, listReviews },
        issues: { listComments },
      },
    });

    const result = await readSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/backend',
        sourceControlProvider: 'github',
      }),
      input: {
        action: 'list_pull_request_comments',
        repositoryFullName: 'acme/backend',
        prNumber: 55,
        sourceControlProvider: 'github',
      },
    });

    if (!('threads' in result)) {
      throw new Error('Expected a comments result.');
    }

    expect(result.threads).toEqual([
      expect.objectContaining({
        id: 'PRRT_live',
        path: 'src/index.ts',
        line: 12,
        outdated: false,
      }),
      expect.objectContaining({
        id: 'PRRT_outdated',
        path: 'src/index.ts',
        line: 42,
        outdated: true,
      }),
    ]);
    expect(result.reviews).toEqual([
      {
        reviewId: '900',
        author: 'roomote-dev[bot]',
        state: 'CHANGES_REQUESTED',
        body: 'Please address the findings.',
        submittedAt: '2026-08-01T00:00:00Z',
        url: 'https://github.com/acme/backend/pull/55#pullrequestreview-900',
      },
    ]);
  });

  it('propagates GitHub rate limits from review-thread pagination', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: 'installation-1',
      externalRepoId: null,
      fullName: 'acme/backend',
      htmlUrl: 'https://github.com/acme/backend',
    });
    mockCreateGitHubToken.mockResolvedValue('github-token');
    const rateLimitError = Object.assign(new Error('API rate limit exceeded'), {
      status: 403,
    });
    mockGetGitHubRateLimitRetryAfterMs.mockImplementation((error: unknown) =>
      error === rateLimitError ? 900_000 : null,
    );
    mockGetOctokit.mockReturnValue({
      graphql: vi.fn().mockRejectedValue(rateLimitError),
      paginate: vi.fn().mockResolvedValue([]),
      rest: {
        pulls: { listReviewComments: vi.fn() },
        issues: { listComments: vi.fn() },
      },
    });

    await expect(
      readSourceControlPullRequestForTaskRun({
        taskRun: makeTaskRun({
          repo: 'acme/backend',
          sourceControlProvider: 'github',
        }),
        input: {
          action: 'list_pull_request_comments',
          repositoryFullName: 'acme/backend',
          prNumber: 55,
          sourceControlProvider: 'github',
        },
      }),
    ).rejects.toBe(rateLimitError);
  });

  it('propagates GitHub 401s so a task-scoped caller can refresh once', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: 'installation-1',
      externalRepoId: null,
      fullName: 'acme/backend',
      htmlUrl: 'https://github.com/acme/backend',
    });
    const unauthorized = Object.assign(new Error('Bad credentials'), {
      status: 401,
    });
    mockGetOctokit.mockReturnValue({
      graphql: vi.fn().mockRejectedValue(unauthorized),
      paginate: vi.fn().mockResolvedValue([]),
      rest: {
        pulls: { listReviewComments: vi.fn() },
        issues: { listComments: vi.fn() },
      },
    });

    await expect(
      readSourceControlPullRequestForTaskRun({
        taskRun: makeTaskRun({
          repo: 'acme/backend',
          sourceControlProvider: 'github',
        }),
        input: {
          action: 'list_pull_request_comments',
          repositoryFullName: 'acme/backend',
          prNumber: 55,
          sourceControlProvider: 'github',
        },
        githubToken: 'github-token',
      }),
    ).rejects.toBe(unauthorized);
  });

  it('paginates every GitHub review thread and every comment in a thread', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: 'installation-1',
      externalRepoId: null,
      fullName: 'acme/backend',
      htmlUrl: 'https://github.com/acme/backend',
    });
    mockCreateGitHubToken.mockResolvedValue('github-token');
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: 'PRRT_first',
                  isResolved: false,
                  isOutdated: false,
                  path: 'src/first.ts',
                  line: 1,
                  originalLine: 1,
                  comments: {
                    nodes: [
                      {
                        databaseId: 100,
                        pullRequestReview: { databaseId: 900 },
                        author: { login: 'reviewer[bot]' },
                        body: 'First comment page.',
                        createdAt: '2026-08-01T00:00:00Z',
                        url: null,
                      },
                    ],
                    pageInfo: {
                      hasNextPage: true,
                      endCursor: 'comment-cursor-1',
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: true, endCursor: 'thread-cursor-1' },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: 'PRRT_second',
                  isResolved: false,
                  isOutdated: false,
                  path: 'src/second.ts',
                  line: 2,
                  originalLine: 2,
                  comments: {
                    nodes: [
                      {
                        databaseId: 200,
                        author: { login: 'reviewer[bot]' },
                        body: 'Finding after the first 100 threads.',
                        createdAt: '2026-08-01T00:00:01Z',
                        url: null,
                      },
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        node: {
          comments: {
            nodes: [
              {
                databaseId: 101,
                author: { login: 'reviewer[bot]' },
                body: 'Comment after the first 100 comments.',
                createdAt: '2026-08-01T00:00:02Z',
                url: null,
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    mockGetOctokit.mockReturnValue({
      graphql,
      paginate: vi.fn().mockResolvedValue([]),
      rest: {
        pulls: { listReviewComments: vi.fn(), listReviews: vi.fn() },
        issues: { listComments: vi.fn() },
      },
    });

    const result = await readSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/backend',
        sourceControlProvider: 'github',
      }),
      input: {
        action: 'list_pull_request_comments',
        repositoryFullName: 'acme/backend',
        prNumber: 55,
        sourceControlProvider: 'github',
      },
    });

    if (!('threads' in result)) {
      throw new Error('Expected a comments result.');
    }

    expect(result.threads).toEqual([
      expect.objectContaining({
        id: 'PRRT_first',
        comments: [
          expect.objectContaining({ id: '100' }),
          expect.objectContaining({ id: '101' }),
        ],
      }),
      expect.objectContaining({
        id: 'PRRT_second',
        comments: [expect.objectContaining({ id: '200' })],
      }),
    ]);
    expect(result.threads[0]?.comments[0]).toMatchObject({
      id: '100',
      reviewId: '900',
    });
    expect(graphql).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('reviewThreads(first: 100, after: $cursor)'),
      expect.objectContaining({ cursor: 'thread-cursor-1' }),
    );
    expect(graphql).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('comments(first: 100, after: $cursor)'),
      { threadId: 'PRRT_first', cursor: 'comment-cursor-1' },
    );
  });

  it('maps GitLab discussions into threads and issue comments', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: null,
      externalRepoId: '101',
      fullName: 'acme/backend',
      htmlUrl: 'https://gitlab.com/acme/backend',
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse([
        {
          id: 'discussion-1',
          notes: [
            {
              id: 1,
              type: 'DiffNote',
              body: 'Inline note',
              resolvable: true,
              resolved: true,
              created_at: '2026-07-01T00:00:00Z',
              author: { username: 'reviewer' },
              position: { new_path: 'src/index.ts', new_line: 12 },
            },
            {
              id: 2,
              type: 'DiffNote',
              body: 'Reply note',
              resolvable: true,
              resolved: true,
              author: { username: 'author' },
            },
          ],
        },
        {
          id: 'discussion-2',
          notes: [
            {
              id: 3,
              type: null,
              body: 'Top-level comment',
              resolvable: false,
              author: { username: 'commenter' },
            },
          ],
        },
        {
          id: 'discussion-3',
          notes: [{ id: 4, system: true, body: 'changed the description' }],
        },
      ]),
    );

    const result = await readSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/backend',
        sourceControlProvider: 'gitlab',
      }),
      input: {
        action: 'list_pull_request_comments',
        repositoryFullName: 'acme/backend',
        prNumber: 42,
        sourceControlProvider: 'gitlab',
      },
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects/101/merge_requests/42/discussions?per_page=100',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result).toMatchObject({
      success: true,
      provider: 'gitlab',
      number: 42,
    });

    if (!('threads' in result)) {
      throw new Error('Expected a comments result.');
    }

    expect(result.threads).toEqual([
      {
        id: 'discussion-1',
        resolved: true,
        path: 'src/index.ts',
        line: 12,
        outdated: null,
        comments: [
          {
            id: '1',
            author: 'reviewer',
            body: 'Inline note',
            createdAt: '2026-07-01T00:00:00Z',
            url: null,
          },
          {
            id: '2',
            author: 'author',
            body: 'Reply note',
            createdAt: null,
            url: null,
          },
        ],
      },
    ]);
    expect(result.issueComments).toEqual([
      {
        id: '3',
        author: 'commenter',
        body: 'Top-level comment',
        createdAt: null,
        url: null,
      },
    ]);
  });

  it('anchors GitLab old-side diff notes with old_path and old_line', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: null,
      externalRepoId: '101',
      fullName: 'acme/backend',
      htmlUrl: 'https://gitlab.com/acme/backend',
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse([
        {
          id: 'discussion-old-side',
          notes: [
            {
              id: 9,
              type: 'DiffNote',
              body: 'This deletion drops the retry path.',
              resolvable: true,
              resolved: false,
              author: { username: 'reviewer' },
              position: {
                new_path: null,
                new_line: null,
                old_path: 'src/index.ts',
                old_line: 17,
              },
            },
          ],
        },
      ]),
    );

    const result = await readSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/backend',
        sourceControlProvider: 'gitlab',
      }),
      input: {
        action: 'list_pull_request_comments',
        repositoryFullName: 'acme/backend',
        prNumber: 42,
        sourceControlProvider: 'gitlab',
      },
      fetchImpl,
    });

    if (!('threads' in result)) {
      throw new Error('Expected a comments result.');
    }

    expect(result.threads).toEqual([
      expect.objectContaining({
        id: 'discussion-old-side',
        path: 'src/index.ts',
        line: 17,
      }),
    ]);
  });

  it('anchors Bitbucket old-side comments with inline.from', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: null,
      externalRepoId: null,
      fullName: 'acme/backend',
      htmlUrl: 'https://bitbucket.org/acme/backend',
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        values: [
          {
            id: 88,
            content: { raw: 'This deletion removes the retry path.' },
            user: { nickname: 'reviewer' },
            inline: { path: 'src/index.ts', from: 21 },
          },
        ],
      }),
    );

    const result = await readSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/backend',
        sourceControlProvider: 'bitbucket',
      }),
      input: {
        action: 'list_pull_request_comments',
        repositoryFullName: 'acme/backend',
        prNumber: 5,
        sourceControlProvider: 'bitbucket',
      },
      fetchImpl,
    });

    if (!('threads' in result)) {
      throw new Error('Expected a comments result.');
    }

    expect(result.threads).toEqual([
      expect.objectContaining({
        id: '88',
        path: 'src/index.ts',
        line: 21,
      }),
    ]);
  });

  it('maps Azure DevOps threads with resolution states', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: null,
      externalRepoId: 'repo-uuid',
      fullName: 'acme/Platform/backend',
      htmlUrl: 'https://dev.azure.com/acme/Platform/_git/backend',
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        value: [
          {
            id: 10,
            status: 'fixed',
            threadContext: {
              filePath: '/src/index.ts',
              rightFileStart: { line: 8 },
            },
            comments: [
              {
                id: 100,
                content: 'Please rename this.',
                commentType: 'text',
                publishedDate: '2026-07-01T00:00:00Z',
                author: { displayName: 'Reviewer' },
              },
              {
                id: 101,
                content: 'Done.',
                commentType: 'text',
                author: { uniqueName: 'author@acme.com' },
              },
            ],
          },
          {
            id: 11,
            status: 'active',
            threadContext: {
              filePath: '/src/other.ts',
              rightFileStart: { line: 3 },
            },
            comments: [
              { id: 102, content: 'Still open.', commentType: 'text' },
            ],
          },
          {
            id: 12,
            status: 'unknown',
            comments: [
              { id: 103, content: 'General PR comment', commentType: 'text' },
            ],
          },
          {
            id: 13,
            comments: [
              {
                id: 104,
                content: 'Policy update',
                commentType: 'system',
              },
            ],
          },
          {
            id: 14,
            status: 'active',
            threadContext: {
              filePath: '/src/deleted.ts',
              leftFileStart: { line: 13 },
            },
            comments: [{ id: 105, content: 'Keep this deletion visible.' }],
          },
        ],
      }),
    );

    const result = await readSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/Platform/backend',
        sourceControlProvider: 'ado',
      }),
      input: {
        action: 'list_pull_request_comments',
        repositoryFullName: 'acme/Platform/backend',
        prNumber: 7,
        sourceControlProvider: 'ado',
      },
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://dev.azure.com/acme/Platform/_apis/git/repositories/repo-uuid/pullrequests/7/threads?api-version=7.1',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Basic OmFkby10b2tlbg==',
        }),
      }),
    );

    if (!('threads' in result)) {
      throw new Error('Expected a comments result.');
    }

    expect(result.threads).toEqual([
      {
        id: '10',
        resolved: true,
        path: '/src/index.ts',
        line: 8,
        outdated: null,
        comments: [
          {
            id: '100',
            author: 'Reviewer',
            body: 'Please rename this.',
            createdAt: '2026-07-01T00:00:00Z',
            url: null,
          },
          {
            id: '101',
            author: 'author@acme.com',
            body: 'Done.',
            createdAt: null,
            url: null,
          },
        ],
      },
      {
        id: '11',
        resolved: false,
        path: '/src/other.ts',
        line: 3,
        outdated: null,
        comments: [
          {
            id: '102',
            author: null,
            body: 'Still open.',
            createdAt: null,
            url: null,
          },
        ],
      },
      {
        id: '14',
        resolved: false,
        path: '/src/deleted.ts',
        line: 13,
        outdated: null,
        comments: [
          {
            id: '105',
            author: null,
            body: 'Keep this deletion visible.',
            createdAt: null,
            url: null,
          },
        ],
      },
    ]);
    expect(result.issueComments).toEqual([
      {
        id: '103',
        author: null,
        body: 'General PR comment',
        createdAt: null,
        url: null,
      },
    ]);
  });

  it('lists open GitHub pull requests as provider-neutral summaries', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: 'installation-1',
      externalRepoId: null,
      fullName: 'acme/backend',
      htmlUrl: 'https://github.com/acme/backend',
    });
    mockCreateGitHubToken.mockResolvedValue('github-token');
    const paginate = vi.fn().mockResolvedValue([
      {
        number: 55,
        id: 5501,
        html_url: 'https://github.com/acme/backend/pull/55',
        title: '[Fix] Read surface',
        state: 'open',
        merged_at: null,
        closed_at: null,
        draft: false,
        created_at: '2026-06-30T00:00:00Z',
        updated_at: '2026-07-01T00:00:00Z',
        labels: [{ name: 'auto-resolve-conflicts' }, { name: undefined }],
        head: {
          ref: 'codex/read-surface',
          sha: 'head-sha',
          repo: { full_name: 'acme/backend' },
        },
        base: {
          ref: 'develop',
          sha: 'base-sha',
          repo: { full_name: 'acme/backend' },
        },
        user: { id: 9, login: 'octocat' },
      },
      {
        number: 54,
        html_url: 'https://github.com/acme/backend/pull/54',
        title: 'Second PR',
        state: 'open',
        merged_at: null,
        draft: true,
        created_at: '2026-06-29T00:00:00Z',
        updated_at: '2026-06-30T00:00:00Z',
        labels: [],
        head: { ref: 'feature/two', sha: 'sha-2', repo: null },
        base: { ref: 'develop', sha: 'base-sha', repo: null },
        user: null,
      },
    ]);
    const pullsList = vi.fn();
    mockGetOctokit.mockReturnValue({
      paginate,
      rest: { pulls: { list: pullsList } },
    });

    const result = await readSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/backend',
        sourceControlProvider: 'github',
      }),
      input: {
        action: 'list_pull_requests',
        repositoryFullName: 'acme/backend',
        limit: 1,
        sourceControlProvider: 'github',
      },
    });

    expect(paginate).toHaveBeenCalledWith(
      pullsList,
      {
        owner: 'acme',
        repo: 'backend',
        state: 'open',
        sort: 'updated',
        direction: 'desc',
        per_page: 100,
      },
      expect.any(Function),
    );

    if (!('pullRequests' in result)) {
      throw new Error('Expected a list result.');
    }

    expect(result.pullRequests).toEqual([
      {
        number: 55,
        externalId: 5501,
        url: 'https://github.com/acme/backend/pull/55',
        title: '[Fix] Read surface',
        body: null,
        state: 'open',
        draft: false,
        sourceBranch: 'codex/read-surface',
        targetBranch: 'develop',
        author: { id: '9', login: 'octocat' },
        updatedAt: '2026-07-01T00:00:00Z',
        createdAt: '2026-06-30T00:00:00Z',
        mergedAt: null,
        closedAt: null,
        labels: ['auto-resolve-conflicts'],
        headSha: 'head-sha',
        baseSha: 'base-sha',
        mergeable: null,
        mergeStateDescription: null,
        isCrossRepository: false,
        headRepositoryFullName: 'acme/backend',
      },
    ]);
    expect(result.warnings).toEqual([
      'Result truncated to the 1 most relevant open pull requests; more exist.',
      'GitHub does not include mergeability in pull request lists; use get_pull_request for a per-PR mergeable signal.',
    ]);
  });

  it('lists open GitLab merge requests with labels and conflict signal', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: null,
      externalRepoId: '101',
      fullName: 'acme/backend',
      htmlUrl: 'https://gitlab.com/acme/backend',
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse([
        {
          iid: 42,
          title: 'Conflicting MR',
          state: 'opened',
          web_url: 'https://gitlab.com/acme/backend/-/merge_requests/42',
          draft: false,
          source_branch: 'feature/work',
          target_branch: 'main',
          has_conflicts: true,
          merge_status: 'cannot_be_merged',
          detailed_merge_status: 'conflict',
          source_project_id: 101,
          target_project_id: 101,
          sha: 'head-sha',
          labels: ['auto-resolve-conflicts'],
          created_at: '2026-06-30T00:00:00Z',
          updated_at: '2026-07-01T00:00:00Z',
          author: { id: 7, username: 'gitlab-user' },
        },
      ]),
    );

    const result = await readSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/backend',
        sourceControlProvider: 'gitlab',
      }),
      input: {
        action: 'list_pull_requests',
        repositoryFullName: 'acme/backend',
        sourceControlProvider: 'gitlab',
      },
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects/101/merge_requests?state=opened&order_by=updated_at&sort=desc&per_page=100&page=1',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ 'PRIVATE-TOKEN': 'gitlab-token' }),
      }),
    );

    if (!('pullRequests' in result)) {
      throw new Error('Expected a list result.');
    }

    expect(result.pullRequests).toEqual([
      {
        number: 42,
        externalId: null,
        url: 'https://gitlab.com/acme/backend/-/merge_requests/42',
        title: 'Conflicting MR',
        body: null,
        state: 'open',
        draft: false,
        sourceBranch: 'feature/work',
        targetBranch: 'main',
        author: { id: '7', login: 'gitlab-user' },
        updatedAt: '2026-07-01T00:00:00Z',
        createdAt: '2026-06-30T00:00:00Z',
        mergedAt: null,
        closedAt: null,
        labels: ['auto-resolve-conflicts'],
        headSha: 'head-sha',
        baseSha: null,
        mergeable: false,
        mergeStateDescription: 'conflict',
        isCrossRepository: false,
        headRepositoryFullName: null,
      },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('truncates GitLab merge request lists to the requested limit', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: null,
      externalRepoId: '101',
      fullName: 'acme/backend',
      htmlUrl: 'https://gitlab.com/acme/backend',
    });
    const makeItem = (iid: number) => ({
      iid,
      title: `MR ${iid}`,
      state: 'opened',
      source_branch: `feature/${iid}`,
      target_branch: 'main',
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([makeItem(3), makeItem(2), makeItem(1)]),
      );

    const result = await readSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/backend',
        sourceControlProvider: 'gitlab',
      }),
      input: {
        action: 'list_pull_requests',
        repositoryFullName: 'acme/backend',
        limit: 2,
        sourceControlProvider: 'gitlab',
      },
      fetchImpl,
    });

    if (!('pullRequests' in result)) {
      throw new Error('Expected a list result.');
    }

    expect(
      result.pullRequests.map((pullRequest) => pullRequest.number),
    ).toEqual([3, 2]);
    expect(result.warnings).toEqual([
      'Result truncated to the 2 most relevant open pull requests; more exist.',
    ]);
  });

  it('lists open Gitea pull requests with label names and mergeable passthrough', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: null,
      externalRepoId: null,
      fullName: 'acme/backend',
      htmlUrl: 'https://git.example.com/acme/backend',
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse([
        {
          number: 8,
          title: 'WIP: Gitea PR',
          state: 'open',
          merged: false,
          mergeable: false,
          html_url: 'https://git.example.com/acme/backend/pulls/8',
          labels: [{ name: 'auto-resolve-conflicts' }],
          created_at: '2026-06-30T00:00:00Z',
          updated_at: '2026-07-01T00:00:00Z',
          user: { id: 4, login: 'gitea-user' },
          head: {
            ref: 'feature/work',
            sha: 'head-sha',
            repo: { full_name: 'acme/backend' },
          },
          base: {
            ref: 'main',
            sha: 'base-sha',
            repo: { full_name: 'acme/backend' },
          },
        },
      ]),
    );

    const result = await readSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/backend',
        sourceControlProvider: 'gitea',
      }),
      input: {
        action: 'list_pull_requests',
        repositoryFullName: 'acme/backend',
        sourceControlProvider: 'gitea',
      },
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://git.example.com/api/v1/repos/acme/backend/pulls?state=open&limit=50&page=1',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'token gitea-token',
        }),
      }),
    );

    if (!('pullRequests' in result)) {
      throw new Error('Expected a list result.');
    }

    expect(result.pullRequests).toEqual([
      {
        number: 8,
        externalId: null,
        url: 'https://git.example.com/acme/backend/pulls/8',
        title: 'WIP: Gitea PR',
        body: null,
        state: 'open',
        draft: true,
        sourceBranch: 'feature/work',
        targetBranch: 'main',
        author: { id: '4', login: 'gitea-user' },
        updatedAt: '2026-07-01T00:00:00Z',
        createdAt: '2026-06-30T00:00:00Z',
        mergedAt: null,
        closedAt: null,
        labels: ['auto-resolve-conflicts'],
        headSha: 'head-sha',
        baseSha: 'base-sha',
        mergeable: false,
        mergeStateDescription: null,
        isCrossRepository: false,
        headRepositoryFullName: 'acme/backend',
      },
    ]);
  });

  it('lists open Bitbucket pull requests across cursor pages without a mergeable signal', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: null,
      externalRepoId: null,
      fullName: 'acme/backend',
      htmlUrl: 'https://bitbucket.org/acme/backend',
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          values: [
            {
              id: 3,
              title: 'First page PR',
              state: 'OPEN',
              draft: false,
              links: {
                html: {
                  href: 'https://bitbucket.org/acme/backend/pull-requests/3',
                },
              },
              author: { uuid: '{u-1}', nickname: 'bb-user' },
              created_on: '2026-06-30T00:00:00Z',
              updated_on: '2026-07-01T00:00:00Z',
              source: {
                branch: { name: 'feature/work' },
                commit: { hash: 'head-sha' },
                repository: { full_name: 'acme/backend' },
              },
              destination: {
                branch: { name: 'main' },
                commit: { hash: 'base-sha' },
                repository: { full_name: 'acme/backend' },
              },
            },
          ],
          next: 'https://api.bitbucket.org/2.0/repositories/acme/backend/pullrequests?page=2',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          values: [
            {
              id: 2,
              title: 'Second page PR',
              state: 'OPEN',
              source: { branch: { name: 'feature/two' } },
              destination: { branch: { name: 'main' } },
            },
          ],
          next: null,
        }),
      );

    const result = await readSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/backend',
        sourceControlProvider: 'bitbucket',
      }),
      input: {
        action: 'list_pull_requests',
        repositoryFullName: 'acme/backend',
        sourceControlProvider: 'bitbucket',
      },
      fetchImpl,
    });

    if (!('pullRequests' in result)) {
      throw new Error('Expected a list result.');
    }

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer bitbucket-token',
        }),
      }),
    );
    expect(
      result.pullRequests.map((pullRequest) => pullRequest.number),
    ).toEqual([3, 2]);
    expect(result.pullRequests[0]).toMatchObject({
      author: { id: '{u-1}', login: 'bb-user' },
      // Bitbucket's PR list carries no labels: unknown, not empty.
      labels: null,
      mergeable: null,
      mergeStateDescription: null,
      headSha: 'head-sha',
      baseSha: 'base-sha',
    });
    expect(result.warnings).toEqual([
      'Bitbucket does not expose a mergeable signal or labels; mergeable is null and labels are empty.',
    ]);
  });

  it('lists open Azure DevOps pull requests with merge status mapping and a labels caveat', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: null,
      externalRepoId: 'repo-uuid',
      fullName: 'acme/Platform/backend',
      htmlUrl: 'https://dev.azure.com/acme/Platform/_git/backend',
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        value: [
          {
            pullRequestId: 7,
            title: 'Conflicting PR',
            status: 'active',
            isDraft: false,
            mergeStatus: 'conflicts',
            creationDate: '2026-06-30T00:00:00Z',
            sourceRefName: 'refs/heads/feature/work',
            targetRefName: 'refs/heads/main',
            lastMergeSourceCommit: { commitId: 'head-sha' },
            lastMergeTargetCommit: { commitId: 'base-sha' },
            createdBy: {
              id: 'user-guid',
              displayName: 'Author',
              uniqueName: 'author@acme.com',
            },
          },
          {
            pullRequestId: 6,
            title: 'Clean PR',
            status: 'active',
            mergeStatus: 'succeeded',
            sourceRefName: 'refs/heads/feature/two',
            targetRefName: 'refs/heads/main',
            labels: [{ name: 'auto-resolve-conflicts' }],
          },
        ],
      }),
    );

    const result = await readSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/Platform/backend',
        sourceControlProvider: 'ado',
      }),
      input: {
        action: 'list_pull_requests',
        repositoryFullName: 'acme/Platform/backend',
        sourceControlProvider: 'ado',
      },
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://dev.azure.com/acme/Platform/_apis/git/repositories/repo-uuid/pullrequests?api-version=7.1&searchCriteria.status=active&%24top=100&%24skip=0',
      expect.objectContaining({ method: 'GET' }),
    );

    if (!('pullRequests' in result)) {
      throw new Error('Expected a list result.');
    }

    expect(result.pullRequests[0]).toMatchObject({
      number: 7,
      url: 'https://dev.azure.com/acme/Platform/_git/backend/pullrequest/7',
      state: 'open',
      sourceBranch: 'feature/work',
      targetBranch: 'main',
      author: { id: 'user-guid', login: 'author@acme.com' },
      updatedAt: null,
      createdAt: '2026-06-30T00:00:00Z',
      // ADO omitted labels from this list payload: unknown, not empty.
      labels: null,
      headSha: 'head-sha',
      baseSha: 'base-sha',
      mergeable: false,
      mergeStateDescription: 'conflicts',
    });
    expect(result.pullRequests[1]).toMatchObject({
      number: 6,
      mergeable: true,
      mergeStateDescription: 'succeeded',
      labels: ['auto-resolve-conflicts'],
    });
    expect(result.warnings).toEqual([
      'Azure DevOps did not include labels in the pull request list; labels may be reported as empty.',
    ]);
  });

  it('requires prNumber for single-PR read actions', async () => {
    const schemaResult = sourceControlPullRequestReadInputSchema.safeParse({
      action: 'get_pull_request',
      repositoryFullName: 'acme/backend',
    });
    expect(schemaResult.success).toBe(false);

    const listSchemaResult = sourceControlPullRequestReadInputSchema.safeParse({
      action: 'list_pull_requests',
      repositoryFullName: 'acme/backend',
    });
    expect(listSchemaResult.success).toBe(true);

    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: null,
      externalRepoId: '101',
      fullName: 'acme/backend',
      htmlUrl: 'https://gitlab.com/acme/backend',
    });

    await expect(
      readSourceControlPullRequestForTaskRun({
        taskRun: makeTaskRun({
          repo: 'acme/backend',
          sourceControlProvider: 'gitlab',
        }),
        input: {
          action: 'get_pull_request',
          repositoryFullName: 'acme/backend',
          sourceControlProvider: 'gitlab',
        },
        fetchImpl: vi.fn(),
      }),
    ).rejects.toThrow('prNumber is required for get_pull_request.');
  });

  it('rejects an explicit provider that conflicts with the repository map', async () => {
    const fetchImpl = vi.fn();

    await expect(
      readSourceControlPullRequestForTaskRun({
        taskRun: makeTaskRun({
          repo: 'acme/frontend',
          selectedRepositories: ['acme/frontend', 'acme/backend'],
          sourceControlProvider: 'github',
          repositoryProviders: { 'acme/backend': 'gitlab' },
        } as unknown as TaskRun['payload']),
        input: {
          action: 'get_pull_request',
          repositoryFullName: 'acme/backend',
          prNumber: 1,
          sourceControlProvider: 'github',
        },
        fetchImpl,
      }),
    ).rejects.toThrow(
      'Source control provider mismatch: task uses GitLab, but request specified GitHub.',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mockRepositoriesFindFirst).not.toHaveBeenCalled();
  });
});

describe('listMergedSourceControlPullRequestsForRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveGitLabToken.mockResolvedValue('gitlab-token');
    mockResolveGiteaToken.mockResolvedValue('gitea-token');
    mockResolveGiteaBaseUrl.mockResolvedValue('https://git.example.com');
    mockBuildGiteaApiBaseUrl.mockReturnValue('https://git.example.com/api/v1');
    mockResolveAdoToken.mockResolvedValue('ado-token');
    mockResolveAdoBaseUrl.mockResolvedValue('https://dev.azure.com');
    mockBuildAdoOrganizationApiBaseUrl.mockReturnValue(
      'https://dev.azure.com/acme',
    );
  });

  function makeRepositoryRow(overrides: Partial<RepositoryRow>): RepositoryRow {
    return {
      id: 'repo-1',
      sourceControlProvider: 'gitlab',
      host: null,
      installationId: null,
      externalRepoId: null,
      fullName: 'acme/backend',
      htmlUrl: 'https://example.com/acme/backend',
      ...overrides,
    };
  }

  it('lists merged GitLab MRs server-side with an updated_after cursor', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse([
        {
          id: 991,
          iid: 42,
          title: 'Merged MR',
          state: 'merged',
          web_url: 'https://gitlab.com/acme/backend/-/merge_requests/42',
          source_branch: 'feature/work',
          target_branch: 'main',
          created_at: '2026-06-30T00:00:00Z',
          updated_at: '2026-07-10T00:00:00Z',
          merged_at: '2026-07-10T00:00:00Z',
          closed_at: null,
          author: { id: 7, username: 'gitlab-user' },
        },
      ]),
    );

    const result = await listMergedSourceControlPullRequestsForRepository({
      repository: makeRepositoryRow({
        sourceControlProvider: 'gitlab',
        externalRepoId: '101',
      }),
      provider: 'gitlab',
      updatedAfter: new Date('2026-07-01T00:00:00Z'),
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects/101/merge_requests?state=merged&order_by=updated_at&sort=desc&per_page=100&page=1&updated_after=2026-07-01T00%3A00%3A00.000Z',
      expect.objectContaining({
        headers: expect.objectContaining({ 'PRIVATE-TOKEN': 'gitlab-token' }),
      }),
    );
    expect(result.pullRequests).toEqual([
      expect.objectContaining({
        number: 42,
        externalId: 991,
        state: 'merged',
        mergedAt: '2026-07-10T00:00:00Z',
        closedAt: null,
        updatedAt: '2026-07-10T00:00:00Z',
        author: { id: '7', login: 'gitlab-user' },
      }),
    ]);
  });

  it('lists GitLab MRs with Authorization Bearer when the deployment token is OAuth-backed', async () => {
    mockResolveGitLabToken.mockResolvedValue('oauth-token');
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse([
        {
          id: 992,
          iid: 43,
          title: 'OAuth listed MR',
          state: 'merged',
          web_url: 'https://gitlab.com/acme/backend/-/merge_requests/43',
          source_branch: 'feature/oauth',
          target_branch: 'main',
          created_at: '2026-06-30T00:00:00Z',
          updated_at: '2026-07-10T00:00:00Z',
          merged_at: '2026-07-10T00:00:00Z',
          closed_at: null,
          author: { id: 8, username: 'oauth-user' },
        },
      ]),
    );

    await listMergedSourceControlPullRequestsForRepository({
      repository: makeRepositoryRow({
        sourceControlProvider: 'gitlab',
        externalRepoId: '101',
      }),
      provider: 'gitlab',
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/merge_requests?'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer oauth-token',
        }),
      }),
    );
  });

  it('lists Gitea merged PRs from the closed list, dropping unmerged rows', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse([
        {
          id: 800,
          number: 8,
          title: 'Merged PR',
          state: 'closed',
          merged: true,
          html_url: 'https://git.example.com/acme/backend/pulls/8',
          created_at: '2026-06-30T00:00:00Z',
          updated_at: '2026-07-09T00:00:00Z',
          merged_at: '2026-07-09T00:00:00Z',
          closed_at: '2026-07-09T00:00:00Z',
          user: { id: 4, login: 'gitea-user' },
        },
        {
          id: 801,
          number: 9,
          title: 'Closed without merging',
          state: 'closed',
          merged: false,
          updated_at: '2026-07-08T00:00:00Z',
        },
      ]),
    );

    const result = await listMergedSourceControlPullRequestsForRepository({
      repository: makeRepositoryRow({ sourceControlProvider: 'gitea' }),
      provider: 'gitea',
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://git.example.com/api/v1/repos/acme/backend/pulls?state=closed&limit=50&page=1&sort=recentupdate',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'token gitea-token',
        }),
      }),
    );
    expect(result.pullRequests).toEqual([
      expect.objectContaining({
        number: 8,
        externalId: 800,
        state: 'merged',
        mergedAt: '2026-07-09T00:00:00Z',
        closedAt: '2026-07-09T00:00:00Z',
      }),
    ]);
  });

  it('lists merged Bitbucket PRs with null merge timestamps and filters by updatedAfter', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        values: [
          {
            id: 3,
            title: 'Recently merged',
            state: 'MERGED',
            created_on: '2026-06-30T00:00:00Z',
            updated_on: '2026-07-10T00:00:00Z',
            author: { uuid: '{u-1}', nickname: 'bb-user' },
            source: { branch: { name: 'feature/one' } },
            destination: { branch: { name: 'main' } },
          },
          {
            id: 2,
            title: 'Old merge',
            state: 'MERGED',
            created_on: '2026-05-01T00:00:00Z',
            updated_on: '2026-06-01T00:00:00Z',
            source: { branch: { name: 'feature/two' } },
            destination: { branch: { name: 'main' } },
          },
        ],
        next: null,
      }),
    );

    const result = await listMergedSourceControlPullRequestsForRepository({
      repository: makeRepositoryRow({ sourceControlProvider: 'bitbucket' }),
      provider: 'bitbucket',
      updatedAfter: new Date('2026-07-01T00:00:00Z'),
      fetchImpl,
    });

    const [requestedUrl] = fetchImpl.mock.calls[0]!;
    expect(String(requestedUrl)).toContain('state=MERGED');
    expect(String(requestedUrl)).toContain('sort=-updated_on');
    expect(result.pullRequests).toEqual([
      expect.objectContaining({
        number: 3,
        externalId: null,
        state: 'merged',
        mergedAt: null,
        closedAt: null,
        updatedAt: '2026-07-10T00:00:00Z',
      }),
    ]);
    expect(result.warnings).toContain(
      'Bitbucket does not expose merge/close timestamps in pull request lists; mergedAt and closedAt are null and updatedAt approximates the merge time.',
    );
  });

  it('lists completed Azure DevOps PRs using closedDate for merge timestamps', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        value: [
          {
            pullRequestId: 7,
            title: 'Completed PR',
            status: 'completed',
            creationDate: '2026-06-30T00:00:00Z',
            closedDate: '2026-07-10T00:00:00Z',
            sourceRefName: 'refs/heads/feature/work',
            targetRefName: 'refs/heads/main',
            createdBy: { id: 'user-guid', uniqueName: 'author@acme.com' },
          },
          {
            pullRequestId: 6,
            title: 'Old completed PR',
            status: 'completed',
            creationDate: '2026-05-01T00:00:00Z',
            closedDate: '2026-06-01T00:00:00Z',
            sourceRefName: 'refs/heads/feature/two',
            targetRefName: 'refs/heads/main',
          },
        ],
      }),
    );

    const result = await listMergedSourceControlPullRequestsForRepository({
      repository: makeRepositoryRow({
        sourceControlProvider: 'ado',
        externalRepoId: 'repo-uuid',
        fullName: 'acme/Platform/backend',
        htmlUrl: 'https://dev.azure.com/acme/Platform/_git/backend',
      }),
      provider: 'ado',
      updatedAfter: new Date('2026-07-01T00:00:00Z'),
      fetchImpl,
    });

    const [requestedUrl] = fetchImpl.mock.calls[0]!;
    expect(String(requestedUrl)).toContain('searchCriteria.status=completed');
    // ADO rows have no updatedAt, so the updatedAfter filter falls back to
    // the closedDate-derived mergedAt and drops the June merge.
    expect(result.pullRequests).toEqual([
      expect.objectContaining({
        number: 7,
        externalId: null,
        state: 'merged',
        updatedAt: null,
        mergedAt: '2026-07-10T00:00:00Z',
        closedAt: '2026-07-10T00:00:00Z',
        author: { id: 'user-guid', login: 'author@acme.com' },
      }),
    ]);
  });

  it('lists merged GitHub PRs from the closed list, dropping unmerged rows', async () => {
    mockCreateGitHubToken.mockResolvedValue('github-token');
    const paginate = vi.fn().mockResolvedValue([
      {
        number: 55,
        id: 5501,
        html_url: 'https://github.com/acme/backend/pull/55',
        title: 'Merged PR',
        state: 'closed',
        merged_at: '2026-07-10T00:00:00Z',
        closed_at: '2026-07-10T00:00:00Z',
        draft: false,
        created_at: '2026-06-30T00:00:00Z',
        updated_at: '2026-07-10T00:00:00Z',
        labels: [],
        head: { ref: 'feature/one', sha: 'head-sha', repo: null },
        base: { ref: 'develop', sha: 'base-sha', repo: null },
        user: { id: 9, login: 'octocat' },
      },
      {
        number: 54,
        id: 5401,
        html_url: 'https://github.com/acme/backend/pull/54',
        title: 'Closed without merging',
        state: 'closed',
        merged_at: null,
        closed_at: '2026-07-09T00:00:00Z',
        draft: false,
        created_at: '2026-06-29T00:00:00Z',
        updated_at: '2026-07-09T00:00:00Z',
        labels: [],
        head: { ref: 'feature/two', sha: 'sha-2', repo: null },
        base: { ref: 'develop', sha: 'base-sha', repo: null },
        user: null,
      },
    ]);
    const pullsList = vi.fn();
    mockGetOctokit.mockReturnValue({
      paginate,
      rest: { pulls: { list: pullsList } },
    });

    const result = await listMergedSourceControlPullRequestsForRepository({
      repository: makeRepositoryRow({
        sourceControlProvider: 'github',
        installationId: 'installation-1',
        fullName: 'acme/backend',
      }),
      provider: 'github',
    });

    expect(paginate).toHaveBeenCalledWith(
      pullsList,
      expect.objectContaining({ state: 'closed' }),
      expect.any(Function),
    );
    expect(result.pullRequests).toEqual([
      expect.objectContaining({
        number: 55,
        externalId: 5501,
        state: 'merged',
        mergedAt: '2026-07-10T00:00:00Z',
        closedAt: '2026-07-10T00:00:00Z',
      }),
    ]);
  });
});
