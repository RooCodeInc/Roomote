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

  it('replies to a GitLab discussion through the deployment token', async () => {
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
        repo: 'acme/backend',
        sourceControlProvider: 'gitlab',
      }),
      input: {
        action: 'reply_to_pull_request_comment',
        repositoryFullName: 'acme/backend',
        prNumber: 42,
        threadId: 'abc123',
        body: 'Thanks, fixed.',
        sourceControlProvider: 'gitlab',
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
      'https://dev.azure.com/acme/_apis/connectionData?api-version=7.1',
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
