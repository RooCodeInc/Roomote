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
  environments: { id: 'environments.id' },
  and: vi.fn((...conditions: unknown[]) => ({ type: 'and', conditions })),
  eq: vi.fn((left: unknown, right: unknown) => ({ type: 'eq', left, right })),
}));

import { writeSourceControlPullRequestForTaskRun } from '../source-control-pull-request-writes';

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
        jsonResponse([{ old_path: 'src/index.ts', new_path: 'src/index.ts' }]),
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
        jsonResponse([{ old_path: 'src/index.ts', new_path: 'src/index.ts' }]),
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

  it('keeps scanning diff pages until the renamed file is found', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: null,
      externalRepoId: '101',
      fullName: 'acme/backend',
      htmlUrl: 'https://gitlab.com/acme/backend',
    });
    const fillerPage = Array.from({ length: 100 }, (_, i) => ({
      old_path: `src/other-${i}.ts`,
      new_path: `src/other-${i}.ts`,
    }));
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
      .mockResolvedValueOnce(jsonResponse(fillerPage))
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

    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      'https://gitlab.com/api/v4/projects/101/merge_requests/42/diffs?page=2&per_page=100',
      expect.objectContaining({ method: 'GET' }),
    );
    const discussionBody = JSON.parse(
      (fetchImpl.mock.calls[3]?.[1] as { body: string }).body,
    ) as { position: Record<string, unknown> };
    expect(discussionBody.position.old_path).toBe('src/legacy/index.ts');
  });

  it('surfaces an explicit warning when the diff scan backstop ends before the listing', async () => {
    mockRepositoriesFindFirst.mockResolvedValue({
      installationId: null,
      externalRepoId: '101',
      fullName: 'acme/backend',
      htmlUrl: 'https://gitlab.com/acme/backend',
    });
    const fillerPage = Array.from({ length: 100 }, (_, i) => ({
      old_path: `src/other-${i}.ts`,
      new_path: `src/other-${i}.ts`,
    }));
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/diffs')) {
        return jsonResponse(fillerPage);
      }
      if (url.endsWith('/discussions')) {
        return jsonResponse({ id: 'disc-9' }, 201);
      }
      return jsonResponse({
        diff_refs: {
          base_sha: 'base1',
          start_sha: 'start1',
          head_sha: 'head1',
        },
      });
    });

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

    const diffCalls = fetchImpl.mock.calls.filter(([url]) =>
      String(url).includes('/diffs'),
    );
    expect(diffCalls).toHaveLength(50);
    expect(result.warnings).toEqual([
      expect.stringContaining(
        'rename resolution fell back to the request path',
      ),
    ]);
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
        jsonResponse([{ old_path: 'src/index.ts', new_path: 'src/index.ts' }]),
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
        jsonResponse([{ old_path: 'src/index.ts', new_path: 'src/index.ts' }]),
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
