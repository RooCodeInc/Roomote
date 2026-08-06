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
}));

vi.mock('@roomote/auth', () => ({
  createGitHubToken: (...args: unknown[]) => mockCreateGitHubToken(...args),
}));

vi.mock('@roomote/github', () => ({
  getOctokit: (...args: unknown[]) => mockGetOctokit(...args),
}));

vi.mock('@roomote/gitlab', () => ({
  resolveGitLabToken: (...args: unknown[]) => mockResolveGitLabToken(...args),
  isGitLabOAuthAccessToken: () => false,
  resolveGitLabBaseUrl: async () => 'https://gitlab.com',
  buildGitLabApiBaseUrl: (baseUrl: string) =>
    `${baseUrl.replace(/\/+$/, '')}/api/v4`,
}));

vi.mock('@roomote/gitea', () => ({
  resolveGiteaToken: (...args: unknown[]) => mockResolveGiteaToken(...args),
  resolveGiteaBaseUrl: (...args: unknown[]) => mockResolveGiteaBaseUrl(...args),
  buildGiteaApiBaseUrl: (...args: unknown[]) =>
    mockBuildGiteaApiBaseUrl(...args),
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
  sourceControlPullRequestWriteInputSchema,
  writeSourceControlPullRequestForTaskRun,
} from '../source-control-pull-request-writes';

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

describe('writeSourceControlPullRequestForTaskRun', () => {
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
  });

  it('replies to a GitLab discussion in a GitHub-primary mixed task', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: null,
      externalRepoId: '101',
      fullName: 'acme/backend',
      htmlUrl: 'https://gitlab.com/acme/backend',
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 501 }, 201));

    const result = await writeSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/frontend',
        selectedRepositories: ['acme/frontend', 'acme/backend'],
        sourceControlProvider: 'github',
        repositoryProviders: { 'acme/backend': 'gitlab' },
      } as unknown as TaskRun['payload']),
      input: {
        action: 'reply_to_pull_request_comment',
        repositoryFullName: 'acme/backend',
        prNumber: 42,
        threadId: 'abc123',
        body: 'Thanks, fixed.',
      },
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects/101/merge_requests/42/discussions/abc123/notes',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'PRIVATE-TOKEN': 'gitlab-token' }),
        body: JSON.stringify({ body: 'Thanks, fixed.' }),
      }),
    );
    expect(result).toMatchObject({
      success: true,
      action: 'reply_to_pull_request_comment',
      provider: 'gitlab',
      repositoryFullName: 'acme/backend',
      number: 42,
      threadId: 'abc123',
      commentId: '501',
      applied: true,
      warnings: [],
    });
  });

  it('resolves a GitLab discussion with a PUT to the discussion resource', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: null,
      externalRepoId: '101',
      fullName: 'acme/backend',
      htmlUrl: 'https://gitlab.com/acme/backend',
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'abc123' }));

    const result = await writeSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/backend',
        sourceControlProvider: 'gitlab',
      }),
      input: {
        action: 'resolve_pull_request_thread',
        repositoryFullName: 'acme/backend',
        prNumber: 42,
        threadId: 'abc123',
        resolved: true,
        sourceControlProvider: 'gitlab',
      },
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects/101/merge_requests/42/discussions/abc123',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({ 'PRIVATE-TOKEN': 'gitlab-token' }),
        body: JSON.stringify({ resolved: true }),
      }),
    );
    expect(result).toMatchObject({
      success: true,
      action: 'resolve_pull_request_thread',
      provider: 'gitlab',
      threadId: 'abc123',
      applied: true,
      warnings: [],
    });
  });

  it('resolves an Azure DevOps thread by patching its status to fixed', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: null,
      externalRepoId: 'repo-uuid',
      fullName: 'acme/Platform/backend',
      htmlUrl: 'https://dev.azure.com/acme/Platform/_git/backend',
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 20, status: 'fixed' }));

    const result = await writeSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/Platform/backend',
        sourceControlProvider: 'ado',
      }),
      input: {
        action: 'resolve_pull_request_thread',
        repositoryFullName: 'acme/Platform/backend',
        prNumber: 7,
        threadId: '20',
        resolved: true,
        sourceControlProvider: 'ado',
      },
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://dev.azure.com/acme/Platform/_apis/git/repositories/repo-uuid/pullrequests/7/threads/20?api-version=7.1',
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({
          Authorization: 'Basic OmFkby10b2tlbg==',
        }),
        body: JSON.stringify({ status: 'fixed' }),
      }),
    );
    expect(result).toMatchObject({
      success: true,
      action: 'resolve_pull_request_thread',
      provider: 'ado',
      number: 7,
      threadId: '20',
      applied: true,
      warnings: [],
    });
  });

  it('submits an Azure DevOps approval as a reviewer vote for the token identity', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: null,
      externalRepoId: 'repo-uuid',
      fullName: 'acme/Platform/backend',
      htmlUrl: 'https://dev.azure.com/acme/Platform/_git/backend',
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ authenticatedUser: { id: 'user-guid' } }),
      )
      .mockResolvedValueOnce(jsonResponse({ vote: 10 }));

    const result = await writeSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/Platform/backend',
        sourceControlProvider: 'ado',
      }),
      input: {
        action: 'submit_pull_request_review',
        repositoryFullName: 'acme/Platform/backend',
        prNumber: 7,
        reviewEvent: 'approve',
        sourceControlProvider: 'ado',
      },
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://dev.azure.com/acme/_apis/connectionData?api-version=7.1-preview',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Basic OmFkby10b2tlbg==',
        }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://dev.azure.com/acme/Platform/_apis/git/repositories/repo-uuid/pullrequests/7/reviewers/user-guid?api-version=7.1',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ vote: 10 }),
      }),
    );
    expect(result).toMatchObject({
      success: true,
      action: 'submit_pull_request_review',
      provider: 'ado',
      number: 7,
      threadId: null,
      commentId: null,
      applied: true,
      warnings: [],
    });
  });

  it('reports Gitea thread resolution as a capability gap without calling the API', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: null,
      externalRepoId: null,
      fullName: 'acme/backend',
      htmlUrl: 'https://git.example.com/acme/backend',
    });
    const fetchImpl = vi.fn();

    const result = await writeSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/backend',
        sourceControlProvider: 'gitea',
      }),
      input: {
        action: 'resolve_pull_request_thread',
        repositoryFullName: 'acme/backend',
        prNumber: 9,
        threadId: '77',
        resolved: true,
        sourceControlProvider: 'gitea',
      },
      fetchImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      action: 'resolve_pull_request_thread',
      provider: 'gitea',
      number: 9,
      threadId: '77',
      applied: false,
      warnings: ['Gitea does not expose review thread resolution.'],
    });
  });

  it('submits a GitHub approval review through the installation token', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: 'installation-1',
      externalRepoId: null,
      fullName: 'acme/backend',
      htmlUrl: 'https://github.com/acme/backend',
    });
    mockCreateGitHubToken.mockResolvedValue('github-token');
    const createReview = vi.fn().mockResolvedValue({
      data: {
        id: 900,
        html_url:
          'https://github.com/acme/backend/pull/55#pullrequestreview-900',
      },
    });
    mockGetOctokit.mockReturnValue({
      rest: { pulls: { createReview } },
    });

    const result = await writeSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/backend',
        sourceControlProvider: 'github',
      }),
      input: {
        action: 'submit_pull_request_review',
        repositoryFullName: 'acme/backend',
        prNumber: 55,
        reviewEvent: 'approve',
        sourceControlProvider: 'github',
      },
    });

    expect(mockCreateGitHubToken).toHaveBeenCalledWith({
      type: 'installationId',
      installationId: 'installation-1',
    });
    expect(mockGetOctokit).toHaveBeenCalledWith('github-token');
    expect(createReview).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'backend',
      pull_number: 55,
      event: 'APPROVE',
    });
    expect(result).toMatchObject({
      success: true,
      action: 'submit_pull_request_review',
      provider: 'github',
      number: 55,
      commentId: '900',
      url: 'https://github.com/acme/backend/pull/55#pullrequestreview-900',
      applied: true,
      warnings: [],
    });
  });

  it('updates a GitLab note in place through the notes endpoint', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: null,
      externalRepoId: '101',
      fullName: 'acme/backend',
      htmlUrl: 'https://gitlab.com/acme/backend',
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ id: 501 }));

    const result = await writeSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/backend',
        sourceControlProvider: 'gitlab',
      }),
      input: {
        action: 'update_pull_request_comment',
        repositoryFullName: 'acme/backend',
        prNumber: 42,
        commentId: '501',
        body: 'Updated fixer comment.',
        sourceControlProvider: 'gitlab',
      },
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects/101/merge_requests/42/notes/501',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({ 'PRIVATE-TOKEN': 'gitlab-token' }),
        body: JSON.stringify({ body: 'Updated fixer comment.' }),
      }),
    );
    expect(result).toMatchObject({
      success: true,
      action: 'update_pull_request_comment',
      provider: 'gitlab',
      number: 42,
      threadId: null,
      commentId: '501',
      applied: true,
      warnings: [],
    });
  });

  it('rejects Azure DevOps comment updates without a threadId', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: null,
      externalRepoId: 'repo-uuid',
      fullName: 'acme/Platform/backend',
      htmlUrl: 'https://dev.azure.com/acme/Platform/_git/backend',
    });
    const fetchImpl = vi.fn();

    await expect(
      writeSourceControlPullRequestForTaskRun({
        taskRun: makeTaskRun({
          repo: 'acme/Platform/backend',
          sourceControlProvider: 'ado',
        }),
        input: {
          action: 'update_pull_request_comment',
          repositoryFullName: 'acme/Platform/backend',
          prNumber: 7,
          commentId: '100',
          body: 'Updated fixer comment.',
          sourceControlProvider: 'ado',
        },
        fetchImpl,
      }),
    ).rejects.toThrow(
      'threadId is required to update an Azure DevOps comment.',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('updates a GitHub issue comment when no threadId is provided', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: 'installation-1',
      externalRepoId: null,
      fullName: 'acme/backend',
      htmlUrl: 'https://github.com/acme/backend',
    });
    mockCreateGitHubToken.mockResolvedValue('github-token');
    const updateComment = vi.fn().mockResolvedValue({
      data: {
        id: 777,
        html_url: 'https://github.com/acme/backend/pull/55#issuecomment-777',
      },
    });
    const updateReviewComment = vi.fn();
    mockGetOctokit.mockReturnValue({
      rest: {
        issues: { updateComment },
        pulls: { updateReviewComment },
      },
    });

    const result = await writeSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/backend',
        sourceControlProvider: 'github',
      }),
      input: {
        action: 'update_pull_request_comment',
        repositoryFullName: 'acme/backend',
        prNumber: 55,
        commentId: '777',
        body: 'Updated fixer comment.',
        sourceControlProvider: 'github',
      },
    });

    expect(updateComment).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'backend',
      comment_id: 777,
      body: 'Updated fixer comment.',
    });
    expect(updateReviewComment).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      action: 'update_pull_request_comment',
      provider: 'github',
      number: 55,
      threadId: null,
      commentId: '777',
      url: 'https://github.com/acme/backend/pull/55#issuecomment-777',
      applied: true,
      warnings: [],
    });
  });

  it('treats blank threadId as omitted and updates a GitHub issue comment', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: 'installation-1',
      externalRepoId: null,
      fullName: 'acme/backend',
      htmlUrl: 'https://github.com/acme/backend',
    });
    mockCreateGitHubToken.mockResolvedValue('github-token');
    const updateComment = vi.fn().mockResolvedValue({
      data: {
        id: 4921152017,
        html_url:
          'https://github.com/acme/backend/pull/16#issuecomment-4921152017',
      },
    });
    const updateReviewComment = vi.fn();
    mockGetOctokit.mockReturnValue({
      rest: {
        issues: { updateComment },
        pulls: { updateReviewComment },
      },
    });

    const parsedInput = sourceControlPullRequestWriteInputSchema.parse({
      action: 'update_pull_request_comment',
      repositoryFullName: 'acme/backend',
      prNumber: 16,
      commentId: '4921152017',
      threadId: '   ',
      body: 'Updated top-level summary.',
      sourceControlProvider: 'github',
    });
    expect(parsedInput.threadId).toBeUndefined();

    const result = await writeSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/backend',
        sourceControlProvider: 'github',
      }),
      input: parsedInput,
    });

    expect(updateComment).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'backend',
      comment_id: 4921152017,
      body: 'Updated top-level summary.',
    });
    expect(updateReviewComment).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      action: 'update_pull_request_comment',
      provider: 'github',
      number: 16,
      threadId: null,
      commentId: '4921152017',
      applied: true,
      warnings: [],
    });
  });

  it('updates a GitHub review comment when a real threadId is provided', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: 'installation-1',
      externalRepoId: null,
      fullName: 'acme/backend',
      htmlUrl: 'https://github.com/acme/backend',
    });
    mockCreateGitHubToken.mockResolvedValue('github-token');
    const updateComment = vi.fn();
    const updateReviewComment = vi.fn().mockResolvedValue({
      data: {
        id: 888,
        html_url: 'https://github.com/acme/backend/pull/55#discussion_r888',
      },
    });
    mockGetOctokit.mockReturnValue({
      rest: {
        issues: { updateComment },
        pulls: { updateReviewComment },
      },
    });

    const result = await writeSourceControlPullRequestForTaskRun({
      taskRun: makeTaskRun({
        repo: 'acme/backend',
        sourceControlProvider: 'github',
      }),
      input: {
        action: 'update_pull_request_comment',
        repositoryFullName: 'acme/backend',
        prNumber: 55,
        commentId: '888',
        threadId: 'PRRT_kwDOrealThread',
        body: 'Updated review thread reply.',
        sourceControlProvider: 'github',
      },
    });

    expect(updateReviewComment).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'backend',
      comment_id: 888,
      body: 'Updated review thread reply.',
    });
    expect(updateComment).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      action: 'update_pull_request_comment',
      provider: 'github',
      number: 55,
      threadId: 'PRRT_kwDOrealThread',
      commentId: '888',
      applied: true,
      warnings: [],
    });
  });

  it('rejects update requests without a commentId before touching the database', async () => {
    const fetchImpl = vi.fn();

    await expect(
      writeSourceControlPullRequestForTaskRun({
        taskRun: makeTaskRun({
          repo: 'acme/backend',
          sourceControlProvider: 'github',
        }),
        input: {
          action: 'update_pull_request_comment',
          repositoryFullName: 'acme/backend',
          prNumber: 1,
          body: 'Updated fixer comment.',
          sourceControlProvider: 'github',
        },
        fetchImpl,
      }),
    ).rejects.toThrow('commentId is required for update_pull_request_comment.');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mockRepositoriesFindFirst).not.toHaveBeenCalled();
  });

  describe('create_pull_request_review_comment', () => {
    const githubRepoRow = {
      installationId: 'installation-1',
      externalRepoId: null,
      fullName: 'acme/backend',
      htmlUrl: 'https://github.com/acme/backend',
    };

    it('posts a GitHub inline comment anchored on the head SHA resolved at call time', async () => {
      mockRepositoriesFindFirst.mockResolvedValue(githubRepoRow);
      mockCreateGitHubToken.mockResolvedValue('github-token');
      const get = vi
        .fn()
        .mockResolvedValue({ data: { head: { sha: 'headsha123' } } });
      const createReviewComment = vi.fn().mockResolvedValue({
        data: {
          id: 3001,
          html_url: 'https://github.com/acme/backend/pull/55#discussion_r3001',
        },
      });
      mockGetOctokit.mockReturnValue({
        rest: { pulls: { get, createReviewComment } },
      });

      const result = await writeSourceControlPullRequestForTaskRun({
        taskRun: makeTaskRun({
          repo: 'acme/backend',
          sourceControlProvider: 'github',
        }),
        input: {
          action: 'create_pull_request_review_comment',
          repositoryFullName: 'acme/backend',
          prNumber: 55,
          path: 'src/index.ts',
          line: 42,
          body: 'Missing error handling here.',
          sourceControlProvider: 'github',
        },
      });

      expect(get).toHaveBeenCalledWith({
        owner: 'acme',
        repo: 'backend',
        pull_number: 55,
      });
      expect(createReviewComment).toHaveBeenCalledWith({
        owner: 'acme',
        repo: 'backend',
        pull_number: 55,
        commit_id: 'headsha123',
        path: 'src/index.ts',
        line: 42,
        side: 'RIGHT',
        body: 'Missing error handling here.',
      });
      expect(result).toMatchObject({
        success: true,
        action: 'create_pull_request_review_comment',
        provider: 'github',
        number: 55,
        threadId: null,
        commentId: '3001',
        url: 'https://github.com/acme/backend/pull/55#discussion_r3001',
        applied: true,
        warnings: [],
      });
    });

    it('passes a GitHub multi-line range through as start_line and start_side', async () => {
      mockRepositoriesFindFirst.mockResolvedValue(githubRepoRow);
      mockCreateGitHubToken.mockResolvedValue('github-token');
      const get = vi
        .fn()
        .mockResolvedValue({ data: { head: { sha: 'headsha123' } } });
      const createReviewComment = vi
        .fn()
        .mockResolvedValue({ data: { id: 3002, html_url: null } });
      mockGetOctokit.mockReturnValue({
        rest: { pulls: { get, createReviewComment } },
      });

      const result = await writeSourceControlPullRequestForTaskRun({
        taskRun: makeTaskRun({
          repo: 'acme/backend',
          sourceControlProvider: 'github',
        }),
        input: {
          action: 'create_pull_request_review_comment',
          repositoryFullName: 'acme/backend',
          prNumber: 55,
          path: 'src/index.ts',
          startLine: 40,
          line: 42,
          body: 'This whole block can be simplified.',
          sourceControlProvider: 'github',
        },
      });

      expect(createReviewComment).toHaveBeenCalledWith(
        expect.objectContaining({
          start_line: 40,
          start_side: 'RIGHT',
          line: 42,
          side: 'RIGHT',
        }),
      );
      expect(result).toMatchObject({ applied: true, warnings: [] });
    });

    it('maps a GitHub 422 to a retryable anchor rejection carrying the provider message', async () => {
      mockRepositoriesFindFirst.mockResolvedValue(githubRepoRow);
      mockCreateGitHubToken.mockResolvedValue('github-token');
      const get = vi
        .fn()
        .mockResolvedValue({ data: { head: { sha: 'headsha123' } } });
      const createReviewComment = vi
        .fn()
        .mockRejectedValue(
          Object.assign(
            new Error(
              'Validation Failed: Pull request review thread line must be part of the diff',
            ),
            { status: 422 },
          ),
        );
      mockGetOctokit.mockReturnValue({
        rest: { pulls: { get, createReviewComment } },
      });

      await expect(
        writeSourceControlPullRequestForTaskRun({
          taskRun: makeTaskRun({
            repo: 'acme/backend',
            sourceControlProvider: 'github',
          }),
          input: {
            action: 'create_pull_request_review_comment',
            repositoryFullName: 'acme/backend',
            prNumber: 55,
            path: 'src/index.ts',
            line: 9999,
            body: 'Missing error handling here.',
            sourceControlProvider: 'github',
          },
        }),
      ).rejects.toMatchObject({
        name: 'SourceControlWriteError',
        httpStatus: 422,
        message: expect.stringContaining(
          'rejected the inline comment anchor (path=src/index.ts, line=9999, side=RIGHT)',
        ),
      });
    });

    it('posts a GitLab positioned discussion using the merge request diff_refs', async () => {
      mockRepositoriesFindFirst.mockResolvedValue({
        installationId: null,
        externalRepoId: '101',
        fullName: 'acme/backend',
        htmlUrl: 'https://gitlab.com/acme/backend',
      });
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            diff_refs: {
              base_sha: 'base1',
              start_sha: 'start1',
              head_sha: 'head1',
            },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse([
            { old_path: 'src/index.ts', new_path: 'src/index.ts' },
          ]),
        )
        .mockResolvedValueOnce(
          jsonResponse({ id: 'disc-9', notes: [{ id: 601 }] }, 201),
        );

      const result = await writeSourceControlPullRequestForTaskRun({
        taskRun: makeTaskRun({
          repo: 'acme/backend',
          sourceControlProvider: 'gitlab',
        }),
        input: {
          action: 'create_pull_request_review_comment',
          repositoryFullName: 'acme/backend',
          prNumber: 42,
          path: 'src/index.ts',
          line: 42,
          body: 'Missing error handling here.',
          sourceControlProvider: 'gitlab',
        },
        fetchImpl,
      });

      expect(fetchImpl).toHaveBeenNthCalledWith(
        1,
        'https://gitlab.com/api/v4/projects/101/merge_requests/42',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(fetchImpl).toHaveBeenNthCalledWith(
        2,
        'https://gitlab.com/api/v4/projects/101/merge_requests/42/diffs?page=1&per_page=100',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(fetchImpl).toHaveBeenNthCalledWith(
        3,
        'https://gitlab.com/api/v4/projects/101/merge_requests/42/discussions',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            body: 'Missing error handling here.',
            position: {
              position_type: 'text',
              base_sha: 'base1',
              start_sha: 'start1',
              head_sha: 'head1',
              new_path: 'src/index.ts',
              old_path: 'src/index.ts',
              new_line: 42,
            },
          }),
        }),
      );
      expect(result).toMatchObject({
        success: true,
        provider: 'gitlab',
        threadId: 'disc-9',
        commentId: '601',
        applied: true,
        warnings: [],
      });
    });

    it('anchors LEFT-side GitLab comments with old_line instead of new_line', async () => {
      mockRepositoriesFindFirst.mockResolvedValue({
        installationId: null,
        externalRepoId: '101',
        fullName: 'acme/backend',
        htmlUrl: 'https://gitlab.com/acme/backend',
      });
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            diff_refs: {
              base_sha: 'base1',
              start_sha: 'start1',
              head_sha: 'head1',
            },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse([
            { old_path: 'src/index.ts', new_path: 'src/index.ts' },
          ]),
        )
        .mockResolvedValueOnce(jsonResponse({ id: 'disc-9' }, 201));

      await writeSourceControlPullRequestForTaskRun({
        taskRun: makeTaskRun({
          repo: 'acme/backend',
          sourceControlProvider: 'gitlab',
        }),
        input: {
          action: 'create_pull_request_review_comment',
          repositoryFullName: 'acme/backend',
          prNumber: 42,
          path: 'src/index.ts',
          line: 17,
          side: 'LEFT',
          body: 'This deletion drops the retry path.',
          sourceControlProvider: 'gitlab',
        },
        fetchImpl,
      });

      const discussionBody = JSON.parse(
        (fetchImpl.mock.calls[2]?.[1] as { body: string }).body,
      ) as { position: Record<string, unknown> };
      expect(discussionBody.position.old_line).toBe(17);
      expect(discussionBody.position.new_line).toBeUndefined();
    });

    it('resolves the real old_path for renamed files from the merge request diffs', async () => {
      mockRepositoriesFindFirst.mockResolvedValue({
        installationId: null,
        externalRepoId: '101',
        fullName: 'acme/backend',
        htmlUrl: 'https://gitlab.com/acme/backend',
      });
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            diff_refs: {
              base_sha: 'base1',
              start_sha: 'start1',
              head_sha: 'head1',
            },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse([
            { old_path: 'src/legacy/index.ts', new_path: 'src/index.ts' },
          ]),
        )
        .mockResolvedValueOnce(jsonResponse({ id: 'disc-9' }, 201));

      await writeSourceControlPullRequestForTaskRun({
        taskRun: makeTaskRun({
          repo: 'acme/backend',
          sourceControlProvider: 'gitlab',
        }),
        input: {
          action: 'create_pull_request_review_comment',
          repositoryFullName: 'acme/backend',
          prNumber: 42,
          path: 'src/index.ts',
          line: 42,
          body: 'Missing error handling here.',
          sourceControlProvider: 'gitlab',
        },
        fetchImpl,
      });

      const discussionBody = JSON.parse(
        (fetchImpl.mock.calls[2]?.[1] as { body: string }).body,
      ) as { position: Record<string, unknown> };
      expect(discussionBody.position.new_path).toBe('src/index.ts');
      expect(discussionBody.position.old_path).toBe('src/legacy/index.ts');
    });

    it('falls back to the same-path pair when the diff listing is unavailable', async () => {
      mockRepositoriesFindFirst.mockResolvedValue({
        installationId: null,
        externalRepoId: '101',
        fullName: 'acme/backend',
        htmlUrl: 'https://gitlab.com/acme/backend',
      });
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            diff_refs: {
              base_sha: 'base1',
              start_sha: 'start1',
              head_sha: 'head1',
            },
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ message: 'nope' }, 500))
        .mockResolvedValueOnce(jsonResponse({ id: 'disc-9' }, 201));

      await writeSourceControlPullRequestForTaskRun({
        taskRun: makeTaskRun({
          repo: 'acme/backend',
          sourceControlProvider: 'gitlab',
        }),
        input: {
          action: 'create_pull_request_review_comment',
          repositoryFullName: 'acme/backend',
          prNumber: 42,
          path: 'src/index.ts',
          line: 42,
          body: 'Missing error handling here.',
          sourceControlProvider: 'gitlab',
        },
        fetchImpl,
      });

      const discussionBody = JSON.parse(
        (fetchImpl.mock.calls[2]?.[1] as { body: string }).body,
      ) as { position: Record<string, unknown> };
      expect(discussionBody.position.new_path).toBe('src/index.ts');
      expect(discussionBody.position.old_path).toBe('src/index.ts');
    });

    it('maps a GitLab 400 on discussions to a retryable anchor rejection', async () => {
      mockRepositoriesFindFirst.mockResolvedValue({
        installationId: null,
        externalRepoId: '101',
        fullName: 'acme/backend',
        htmlUrl: 'https://gitlab.com/acme/backend',
      });
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            diff_refs: {
              base_sha: 'base1',
              start_sha: 'start1',
              head_sha: 'head1',
            },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse([
            { old_path: 'src/index.ts', new_path: 'src/index.ts' },
          ]),
        )
        .mockResolvedValueOnce(
          jsonResponse({ message: 'line_code must be a valid line code' }, 400),
        );

      await expect(
        writeSourceControlPullRequestForTaskRun({
          taskRun: makeTaskRun({
            repo: 'acme/backend',
            sourceControlProvider: 'gitlab',
          }),
          input: {
            action: 'create_pull_request_review_comment',
            repositoryFullName: 'acme/backend',
            prNumber: 42,
            path: 'src/index.ts',
            line: 9999,
            body: 'Missing error handling here.',
            sourceControlProvider: 'gitlab',
          },
          fetchImpl,
        }),
      ).rejects.toMatchObject({
        name: 'SourceControlWriteError',
        httpStatus: 422,
        message: expect.stringContaining(
          'target a line changed in this merge request',
        ),
      });
    });

    it('reports missing GitLab diff_refs as a retryable 409', async () => {
      mockRepositoriesFindFirst.mockResolvedValue({
        installationId: null,
        externalRepoId: '101',
        fullName: 'acme/backend',
        htmlUrl: 'https://gitlab.com/acme/backend',
      });
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ diff_refs: null }));

      await expect(
        writeSourceControlPullRequestForTaskRun({
          taskRun: makeTaskRun({
            repo: 'acme/backend',
            sourceControlProvider: 'gitlab',
          }),
          input: {
            action: 'create_pull_request_review_comment',
            repositoryFullName: 'acme/backend',
            prNumber: 42,
            path: 'src/index.ts',
            line: 42,
            body: 'Missing error handling here.',
            sourceControlProvider: 'gitlab',
          },
          fetchImpl,
        }),
      ).rejects.toMatchObject({
        name: 'SourceControlWriteError',
        httpStatus: 409,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('degrades a GitLab multi-line range to the end line with a warning', async () => {
      mockRepositoriesFindFirst.mockResolvedValue({
        installationId: null,
        externalRepoId: '101',
        fullName: 'acme/backend',
        htmlUrl: 'https://gitlab.com/acme/backend',
      });
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            diff_refs: {
              base_sha: 'base1',
              start_sha: 'start1',
              head_sha: 'head1',
            },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse([
            { old_path: 'src/index.ts', new_path: 'src/index.ts' },
          ]),
        )
        .mockResolvedValueOnce(jsonResponse({ id: 'disc-9' }, 201));

      const result = await writeSourceControlPullRequestForTaskRun({
        taskRun: makeTaskRun({
          repo: 'acme/backend',
          sourceControlProvider: 'gitlab',
        }),
        input: {
          action: 'create_pull_request_review_comment',
          repositoryFullName: 'acme/backend',
          prNumber: 42,
          path: 'src/index.ts',
          startLine: 40,
          line: 42,
          body: 'This whole block can be simplified.',
          sourceControlProvider: 'gitlab',
        },
        fetchImpl,
      });

      expect(result).toMatchObject({
        applied: true,
        warnings: [
          'GitLab does not support multi-line comment positions through this surface; the comment is anchored to line 42.',
        ],
      });
    });

    it('posts a Gitea single-comment review with a positioned comment', async () => {
      mockRepositoriesFindFirst.mockResolvedValue({
        installationId: null,
        externalRepoId: null,
        fullName: 'acme/backend',
        htmlUrl: 'https://git.example.com/acme/backend',
      });
      const fetchImpl = vi.fn().mockResolvedValueOnce(
        jsonResponse(
          {
            id: 71,
            html_url: 'https://git.example.com/acme/backend/pulls/9#review-71',
          },
          201,
        ),
      );

      const result = await writeSourceControlPullRequestForTaskRun({
        taskRun: makeTaskRun({
          repo: 'acme/backend',
          sourceControlProvider: 'gitea',
        }),
        input: {
          action: 'create_pull_request_review_comment',
          repositoryFullName: 'acme/backend',
          prNumber: 9,
          path: 'src/index.ts',
          line: 42,
          body: 'Missing error handling here.',
          sourceControlProvider: 'gitea',
        },
        fetchImpl,
      });

      expect(fetchImpl).toHaveBeenCalledWith(
        'https://git.example.com/api/v1/repos/acme/backend/pulls/9/reviews',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            event: 'COMMENT',
            body: '',
            comments: [
              {
                path: 'src/index.ts',
                body: 'Missing error handling here.',
                new_position: 42,
              },
            ],
          }),
        }),
      );
      expect(result).toMatchObject({
        success: true,
        provider: 'gitea',
        threadId: '71',
        url: 'https://git.example.com/acme/backend/pulls/9#review-71',
        applied: true,
        warnings: [],
      });
    });

    it('maps a Gitea 422 to a retryable anchor rejection', async () => {
      mockRepositoriesFindFirst.mockResolvedValue({
        installationId: null,
        externalRepoId: null,
        fullName: 'acme/backend',
        htmlUrl: 'https://git.example.com/acme/backend',
      });
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({ message: 'position is invalid' }, 422),
        );

      await expect(
        writeSourceControlPullRequestForTaskRun({
          taskRun: makeTaskRun({
            repo: 'acme/backend',
            sourceControlProvider: 'gitea',
          }),
          input: {
            action: 'create_pull_request_review_comment',
            repositoryFullName: 'acme/backend',
            prNumber: 9,
            path: 'src/index.ts',
            line: 9999,
            body: 'Missing error handling here.',
            sourceControlProvider: 'gitea',
          },
          fetchImpl,
        }),
      ).rejects.toMatchObject({
        name: 'SourceControlWriteError',
        httpStatus: 422,
        message: expect.stringContaining('rejected the inline comment anchor'),
      });
    });

    it('posts a Bitbucket inline comment anchored with to on the destination side', async () => {
      mockRepositoriesFindFirst.mockResolvedValue({
        installationId: null,
        externalRepoId: null,
        fullName: 'acme/backend',
        htmlUrl: 'https://bitbucket.org/acme/backend',
      });
      const fetchImpl = vi.fn().mockResolvedValueOnce(
        jsonResponse(
          {
            id: 88,
            links: {
              html: {
                href: 'https://bitbucket.org/acme/backend/pull-requests/5#comment-88',
              },
            },
          },
          201,
        ),
      );

      const result = await writeSourceControlPullRequestForTaskRun({
        taskRun: makeTaskRun({
          repo: 'acme/backend',
          sourceControlProvider: 'bitbucket',
        }),
        input: {
          action: 'create_pull_request_review_comment',
          repositoryFullName: 'acme/backend',
          prNumber: 5,
          path: 'src/index.ts',
          line: 42,
          body: 'Missing error handling here.',
          sourceControlProvider: 'bitbucket',
        },
        fetchImpl,
      });

      const [url, request] = fetchImpl.mock.calls[0] as [
        string,
        { method: string; body: string },
      ];
      expect(url).toContain('/pullrequests/5/comments');
      expect(JSON.parse(request.body)).toEqual({
        content: { raw: 'Missing error handling here.' },
        inline: { path: 'src/index.ts', to: 42 },
      });
      expect(result).toMatchObject({
        success: true,
        provider: 'bitbucket',
        threadId: '88',
        commentId: '88',
        applied: true,
        warnings: [],
      });
    });

    it('anchors LEFT-side Bitbucket comments with from instead of to', async () => {
      mockRepositoriesFindFirst.mockResolvedValue({
        installationId: null,
        externalRepoId: null,
        fullName: 'acme/backend',
        htmlUrl: 'https://bitbucket.org/acme/backend',
      });
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ id: 89 }, 201));

      await writeSourceControlPullRequestForTaskRun({
        taskRun: makeTaskRun({
          repo: 'acme/backend',
          sourceControlProvider: 'bitbucket',
        }),
        input: {
          action: 'create_pull_request_review_comment',
          repositoryFullName: 'acme/backend',
          prNumber: 5,
          path: 'src/index.ts',
          line: 17,
          side: 'LEFT',
          body: 'This deletion drops the retry path.',
          sourceControlProvider: 'bitbucket',
        },
        fetchImpl,
      });

      const request = fetchImpl.mock.calls[0]?.[1] as { body: string };
      expect(JSON.parse(request.body)).toMatchObject({
        inline: { path: 'src/index.ts', from: 17 },
      });
    });

    it('creates an Azure DevOps thread with a right-side file range including startLine', async () => {
      mockRepositoriesFindFirst.mockResolvedValue({
        installationId: null,
        externalRepoId: 'repo-uuid',
        fullName: 'acme/Platform/backend',
        htmlUrl: 'https://dev.azure.com/acme/Platform/_git/backend',
      });
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({ id: 31, comments: [{ id: 1 }] }, 200),
        );

      const result = await writeSourceControlPullRequestForTaskRun({
        taskRun: makeTaskRun({
          repo: 'acme/Platform/backend',
          sourceControlProvider: 'ado',
        }),
        input: {
          action: 'create_pull_request_review_comment',
          repositoryFullName: 'acme/Platform/backend',
          prNumber: 7,
          path: 'src/index.ts',
          startLine: 40,
          line: 42,
          body: 'This whole block can be simplified.',
          sourceControlProvider: 'ado',
        },
        fetchImpl,
      });

      expect(fetchImpl).toHaveBeenCalledWith(
        'https://dev.azure.com/acme/Platform/_apis/git/repositories/repo-uuid/pullrequests/7/threads?api-version=7.1',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            comments: [
              {
                content: 'This whole block can be simplified.',
                commentType: 'text',
              },
            ],
            status: 'active',
            threadContext: {
              filePath: '/src/index.ts',
              rightFileStart: { line: 40, offset: 1 },
              rightFileEnd: { line: 42, offset: 1 },
            },
          }),
        }),
      );
      expect(result).toMatchObject({
        success: true,
        provider: 'ado',
        threadId: '31',
        commentId: '1',
        applied: true,
        warnings: [],
      });
    });

    it('anchors LEFT-side Azure DevOps comments with leftFileStart and leftFileEnd', async () => {
      mockRepositoriesFindFirst.mockResolvedValue({
        installationId: null,
        externalRepoId: 'repo-uuid',
        fullName: 'acme/Platform/backend',
        htmlUrl: 'https://dev.azure.com/acme/Platform/_git/backend',
      });
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ id: 32 }, 200));

      await writeSourceControlPullRequestForTaskRun({
        taskRun: makeTaskRun({
          repo: 'acme/Platform/backend',
          sourceControlProvider: 'ado',
        }),
        input: {
          action: 'create_pull_request_review_comment',
          repositoryFullName: 'acme/Platform/backend',
          prNumber: 7,
          path: 'src/index.ts',
          line: 17,
          side: 'LEFT',
          body: 'This deletion drops the retry path.',
          sourceControlProvider: 'ado',
        },
        fetchImpl,
      });

      const request = fetchImpl.mock.calls[0]?.[1] as { body: string };
      expect(JSON.parse(request.body)).toMatchObject({
        threadContext: {
          filePath: '/src/index.ts',
          leftFileStart: { line: 17, offset: 1 },
          leftFileEnd: { line: 17, offset: 1 },
        },
      });
    });

    it('rejects requests without a path, line, or body before touching the database', async () => {
      const fetchImpl = vi.fn();
      const base = {
        action: 'create_pull_request_review_comment' as const,
        repositoryFullName: 'acme/backend',
        prNumber: 1,
        sourceControlProvider: 'github' as const,
      };
      const taskRun = makeTaskRun({
        repo: 'acme/backend',
        sourceControlProvider: 'github',
      });

      await expect(
        writeSourceControlPullRequestForTaskRun({
          taskRun,
          input: { ...base, line: 42, body: 'x' },
          fetchImpl,
        }),
      ).rejects.toThrow(
        'path is required for create_pull_request_review_comment.',
      );
      await expect(
        writeSourceControlPullRequestForTaskRun({
          taskRun,
          input: { ...base, path: 'src/index.ts', body: 'x' },
          fetchImpl,
        }),
      ).rejects.toThrow(
        'line is required for create_pull_request_review_comment.',
      );
      await expect(
        writeSourceControlPullRequestForTaskRun({
          taskRun,
          input: { ...base, path: 'src/index.ts', line: 42 },
          fetchImpl,
        }),
      ).rejects.toThrow(
        'body is required for create_pull_request_review_comment.',
      );
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(mockRepositoriesFindFirst).not.toHaveBeenCalled();
    });

    it('rejects a startLine greater than line', async () => {
      await expect(
        writeSourceControlPullRequestForTaskRun({
          taskRun: makeTaskRun({
            repo: 'acme/backend',
            sourceControlProvider: 'github',
          }),
          input: {
            action: 'create_pull_request_review_comment',
            repositoryFullName: 'acme/backend',
            prNumber: 1,
            path: 'src/index.ts',
            startLine: 50,
            line: 42,
            body: 'x',
            sourceControlProvider: 'github',
          },
        }),
      ).rejects.toThrow('startLine must not be greater than line');
    });
  });

  it('rejects resolve requests without a threadId before touching the database', async () => {
    const fetchImpl = vi.fn();

    await expect(
      writeSourceControlPullRequestForTaskRun({
        taskRun: makeTaskRun({
          repo: 'acme/backend',
          sourceControlProvider: 'github',
        }),
        input: {
          action: 'resolve_pull_request_thread',
          repositoryFullName: 'acme/backend',
          prNumber: 1,
          resolved: true,
          sourceControlProvider: 'github',
        },
        fetchImpl,
      }),
    ).rejects.toThrow('threadId is required for resolve_pull_request_thread.');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mockRepositoriesFindFirst).not.toHaveBeenCalled();
  });
});
