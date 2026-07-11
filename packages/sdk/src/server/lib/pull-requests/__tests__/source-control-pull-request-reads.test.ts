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
        findFirst: (...args: unknown[]) => mockRepositoriesFindFirst(...args),
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

import { readSourceControlPullRequestForTaskRun } from '../source-control-pull-request-reads';

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

  it('reads GitLab merge request details through the deployment token', async () => {
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
        repo: 'acme/backend',
        sourceControlProvider: 'gitlab',
      }),
      input: {
        action: 'get_pull_request',
        repositoryFullName: 'acme/backend',
        prNumber: 42,
        sourceControlProvider: 'gitlab',
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

  it('rejects reads whose provider does not match the task payload', async () => {
    const fetchImpl = vi.fn();

    await expect(
      readSourceControlPullRequestForTaskRun({
        taskRun: makeTaskRun({
          repo: 'acme/backend',
          sourceControlProvider: 'gitlab',
        }),
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
