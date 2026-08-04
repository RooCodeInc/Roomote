import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaskRun } from '@roomote/db/server';

const {
  mockAssertRepositoryInTaskRunScope,
  mockCreateGiteaIssueComment,
  mockCreateGitHubToken,
  mockCreateGitLabIssueNote,
  mockGetOctokit,
  mockResolveGiteaProviderContext,
  mockResolveGitLabProviderContext,
  mockResolveRepositoryRow,
} = vi.hoisted(() => ({
  mockAssertRepositoryInTaskRunScope: vi.fn(),
  mockCreateGiteaIssueComment: vi.fn(),
  mockCreateGitHubToken: vi.fn(),
  mockCreateGitLabIssueNote: vi.fn(),
  mockGetOctokit: vi.fn(),
  mockResolveGiteaProviderContext: vi.fn(),
  mockResolveGitLabProviderContext: vi.fn(),
  mockResolveRepositoryRow: vi.fn(),
}));

vi.mock('@roomote/auth', () => ({
  createGitHubToken: (...args: unknown[]) => mockCreateGitHubToken(...args),
}));
vi.mock('@roomote/github', () => ({
  getOctokit: (...args: unknown[]) => mockGetOctokit(...args),
}));
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
  provider: 'github' | 'gitlab' | 'gitea' | 'bitbucket',
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
    mockCreateGitHubToken.mockResolvedValue('github-token');
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

  it('routes a GitLab issue in a GitHub-primary mixed task', async () => {
    mockResolveRepositoryRow.mockResolvedValue({
      id: 'repo-1',
      sourceControlProvider: 'gitlab',
      host: null,
      installationId: null,
      externalRepoId: '123',
      fullName: 'acme/backend',
      htmlUrl: 'https://gitlab.com/acme/backend',
    });
    mockResolveGitLabProviderContext.mockResolvedValue({
      projectId: '123',
      token: 'server-side-token',
      apiBaseUrl: 'https://gitlab.com/api/v4',
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          iid: 9,
          title: 'Broken checkout',
          state: 'opened',
          web_url: 'https://gitlab.com/acme/backend/-/issues/9',
          author: { username: 'alice' },
          labels: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const mixedTaskRun = taskRun('github');
    mixedTaskRun.payload = {
      repo: 'acme/frontend',
      selectedRepositories: ['acme/frontend', 'acme/backend'],
      sourceControlProvider: 'github',
      sourceControlHost: 'github.com',
      repositoryProviders: { 'acme/backend': 'gitlab' },
    } as unknown as TaskRun['payload'];

    const result = await manageSourceControlIssueForTaskRun({
      taskRun: mixedTaskRun,
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
      host: undefined,
    });
    expect(result).toMatchObject({ provider: 'gitlab', number: 9 });
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
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          number: 12,
          title: 'Plan needed',
          body: 'Please plan this',
          state: 'open',
          html_url: 'https://git.example.com/acme/backend/issues/12',
          user: { login: 'alice' },
          labels: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await manageSourceControlIssueForTaskRun({
      taskRun: taskRun('gitea'),
      input: {
        action: 'create_issue_comment',
        repositoryFullName: 'acme/backend',
        issueNumber: 12,
        body: 'Proposed plan',
      },
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://git.example.com/api/v1/repos/acme/backend/issues/12',
      expect.objectContaining({ method: 'GET' }),
    );
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

  it('rejects Gitea list_issue_comments when the target is a pull request', async () => {
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
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          number: 18,
          title: 'Ship feature',
          body: 'PR body',
          state: 'open',
          html_url: 'https://git.example.com/acme/backend/pulls/18',
          pull_request: {
            merged: false,
            merged_at: null,
          },
          user: { login: 'alice' },
          labels: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await expect(
      manageSourceControlIssueForTaskRun({
        taskRun: taskRun('gitea'),
        input: {
          action: 'list_issue_comments',
          repositoryFullName: 'acme/backend',
          issueNumber: 18,
        },
        fetchImpl,
      }),
    ).rejects.toThrow('The requested issue is a pull request.');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects Gitea create_issue_comment when the target is a pull request', async () => {
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
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          number: 18,
          title: 'Ship feature',
          body: 'PR body',
          state: 'open',
          html_url: 'https://git.example.com/acme/backend/pulls/18',
          pull_request: {
            merged: false,
            merged_at: null,
          },
          user: { login: 'alice' },
          labels: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await expect(
      manageSourceControlIssueForTaskRun({
        taskRun: taskRun('gitea'),
        input: {
          action: 'create_issue_comment',
          repositoryFullName: 'acme/backend',
          issueNumber: 18,
          body: 'Should not post',
        },
        fetchImpl,
      }),
    ).rejects.toThrow('The requested issue is a pull request.');

    expect(mockCreateGiteaIssueComment).not.toHaveBeenCalled();
  });

  it('rejects GitHub list_issue_comments when the target is a pull request', async () => {
    mockResolveRepositoryRow.mockResolvedValue({
      id: 'repo-gh',
      sourceControlProvider: 'github',
      host: null,
      installationId: 99,
      externalRepoId: '1',
      fullName: 'acme/backend',
      htmlUrl: 'https://github.com/acme/backend',
    });
    const getIssue = vi.fn().mockResolvedValue({
      data: {
        number: 18,
        pull_request: {
          url: 'https://api.github.com/repos/acme/backend/pulls/18',
        },
      },
    });
    const listComments = vi.fn();
    mockGetOctokit.mockReturnValue({
      rest: {
        issues: {
          get: getIssue,
          listComments,
        },
      },
      paginate: vi.fn(),
    });

    await expect(
      manageSourceControlIssueForTaskRun({
        taskRun: taskRun('github'),
        input: {
          action: 'list_issue_comments',
          repositoryFullName: 'acme/backend',
          issueNumber: 18,
        },
      }),
    ).rejects.toThrow('The requested issue is a pull request.');

    expect(getIssue).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'backend',
      issue_number: 18,
    });
    expect(listComments).not.toHaveBeenCalled();
  });

  it('rejects GitHub create_issue_comment when the target is a pull request', async () => {
    mockResolveRepositoryRow.mockResolvedValue({
      id: 'repo-gh',
      sourceControlProvider: 'github',
      host: null,
      installationId: 99,
      externalRepoId: '1',
      fullName: 'acme/backend',
      htmlUrl: 'https://github.com/acme/backend',
    });
    const getIssue = vi.fn().mockResolvedValue({
      data: {
        number: 18,
        pull_request: {
          url: 'https://api.github.com/repos/acme/backend/pulls/18',
        },
      },
    });
    const createComment = vi.fn();
    mockGetOctokit.mockReturnValue({
      rest: {
        issues: {
          get: getIssue,
          createComment,
        },
      },
    });

    await expect(
      manageSourceControlIssueForTaskRun({
        taskRun: taskRun('github'),
        input: {
          action: 'create_issue_comment',
          repositoryFullName: 'acme/backend',
          issueNumber: 18,
          body: 'Should not post',
        },
      }),
    ).rejects.toThrow('The requested issue is a pull request.');

    expect(createComment).not.toHaveBeenCalled();
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
