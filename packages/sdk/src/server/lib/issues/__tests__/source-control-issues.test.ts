import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaskRun } from '@roomote/db/server';

const {
  mockAssertRepositoryInTaskRunScope,
  mockCreateGiteaIssueComment,
  mockCreateGitLabIssueNote,
  mockResolveGiteaProviderContext,
  mockResolveGitLabProviderContext,
  mockResolveRepositoryRow,
} = vi.hoisted(() => ({
  mockAssertRepositoryInTaskRunScope: vi.fn(),
  mockCreateGiteaIssueComment: vi.fn(),
  mockCreateGitLabIssueNote: vi.fn(),
  mockResolveGiteaProviderContext: vi.fn(),
  mockResolveGitLabProviderContext: vi.fn(),
  mockResolveRepositoryRow: vi.fn(),
}));

vi.mock('@roomote/auth', () => ({ createGitHubToken: vi.fn() }));
vi.mock('@roomote/github', () => ({ getOctokit: vi.fn() }));
vi.mock('@roomote/gitlab', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/gitlab')>()),
  createGitLabIssueNote: mockCreateGitLabIssueNote,
}));
vi.mock('@roomote/gitea', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/gitea')>()),
  createGiteaIssueComment: mockCreateGiteaIssueComment,
}));

vi.mock(
  '../../pull-requests/source-control-pull-request-provider-context',
  () => ({
    resolveGitLabProviderContext: mockResolveGitLabProviderContext,
    resolveGiteaProviderContext: mockResolveGiteaProviderContext,
  }),
);

vi.mock(
  '../../pull-requests/source-control-pull-request-shared',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../pull-requests/source-control-pull-request-shared')
      >();

    return {
      ...actual,
      assertRepositoryInTaskRunScope: mockAssertRepositoryInTaskRunScope,
      resolveRepositoryRow: mockResolveRepositoryRow,
    };
  },
);

import {
  manageSourceControlIssueForTaskRun,
  sourceControlIssueInputSchema,
} from '../source-control-issues';

function taskRun(
  provider: 'gitlab' | 'gitea' | 'bitbucket',
  sourceControlHost = 'git.example.com',
): TaskRun {
  return {
    id: 17,
    payload: {
      repo: 'acme/backend',
      sourceControlProvider: provider,
      sourceControlHost,
      selectedRepositories: ['acme/backend'],
    },
  } as unknown as TaskRun;
}

describe('manageSourceControlIssueForTaskRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertRepositoryInTaskRunScope.mockResolvedValue(undefined);
  });

  it('reads and normalizes a host-scoped GitLab issue', async () => {
    mockResolveRepositoryRow.mockResolvedValue({
      id: 'repo-1',
      sourceControlProvider: 'gitlab',
      host: 'git.example.com',
      installationId: null,
      externalRepoId: '123',
      fullName: 'acme/backend',
      htmlUrl: 'https://git.example.com/acme/backend',
    });
    mockResolveGitLabProviderContext.mockResolvedValue({
      projectId: '123',
      token: 'server-side-token',
      apiBaseUrl: 'https://git.example.com/api/v4',
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          iid: 9,
          title: 'Broken checkout',
          description: 'Checkout fails.',
          state: 'opened',
          web_url: 'https://git.example.com/acme/backend/-/issues/9',
          author: { username: 'alice' },
          labels: ['bug'],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await manageSourceControlIssueForTaskRun({
      taskRun: taskRun('gitlab'),
      input: {
        action: 'get_issue',
        repositoryFullName: 'acme/backend',
        issueNumber: 9,
      },
      fetchImpl,
    });

    expect(mockResolveRepositoryRow).toHaveBeenCalledWith({
      provider: 'gitlab',
      repositoryFullName: 'acme/backend',
      host: 'git.example.com',
    });
    expect(mockResolveGitLabProviderContext).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'repo-1' }),
      'read',
      'GitLab issues',
    );
    expect(result).toMatchObject({
      action: 'get_issue',
      provider: 'gitlab',
      number: 9,
      state: 'open',
      labels: ['bug'],
    });
  });

  it('posts a Gitea issue comment with server-resolved credentials', async () => {
    mockResolveRepositoryRow.mockResolvedValue({
      id: 'repo-2',
      sourceControlProvider: 'gitea',
      host: 'git.example.com',
      installationId: null,
      externalRepoId: '456',
      fullName: 'acme/backend',
      htmlUrl: 'https://git.example.com/acme/backend',
    });
    mockResolveGiteaProviderContext.mockResolvedValue({
      apiBaseUrl: 'https://git.example.com/api/v1',
      baseUrl: 'https://git.example.com',
      owner: 'acme',
      repo: 'backend',
      token: 'server-side-token',
    });
    mockCreateGiteaIssueComment.mockResolvedValue({ id: 77 });

    const result = await manageSourceControlIssueForTaskRun({
      taskRun: taskRun('gitea'),
      input: {
        action: 'create_issue_comment',
        repositoryFullName: 'acme/backend',
        issueNumber: 12,
        body: 'Proposed plan',
      },
    });

    expect(mockCreateGiteaIssueComment).toHaveBeenCalledWith({
      repositoryFullName: 'acme/backend',
      issueNumber: 12,
      body: 'Proposed plan',
      token: 'server-side-token',
      baseUrl: 'https://git.example.com',
      apiBaseUrl: 'https://git.example.com/api/v1',
    });
    expect(result).toMatchObject({
      action: 'create_issue_comment',
      provider: 'gitea',
      commentId: '77',
    });
  });

  it('rejects providers without issue capabilities', async () => {
    await expect(
      manageSourceControlIssueForTaskRun({
        taskRun: taskRun('bitbucket'),
        input: {
          action: 'get_issue',
          repositoryFullName: 'acme/backend',
          issueNumber: 4,
        },
      }),
    ).rejects.toThrow('Bitbucket Cloud issue operations are not supported');

    expect(mockResolveRepositoryRow).not.toHaveBeenCalled();
  });
});

describe('sourceControlIssueInputSchema', () => {
  it('requires a body only when creating an issue comment', () => {
    expect(
      sourceControlIssueInputSchema.safeParse({
        action: 'create_issue_comment',
        repositoryFullName: 'acme/backend',
        issueNumber: 5,
      }).success,
    ).toBe(false);
    expect(
      sourceControlIssueInputSchema.safeParse({
        action: 'get_issue',
        repositoryFullName: 'acme/backend',
        issueNumber: 5,
      }).success,
    ).toBe(true);
  });
});
