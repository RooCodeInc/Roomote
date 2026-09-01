import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAcquireLifecycleLock,
  mockCreateGitHubToken,
  mockFindAssociation,
  mockGetSetting,
  mockGetPrAction,
  mockGetOctokit,
  mockGraphql,
  mockPullRequestGet,
  mockReleaseLifecycleLock,
  mockResolveRepositoryRow,
  mockResolveGitLabProviderContext,
  mockResolveGiteaProviderContext,
  mockResolveBitbucketProviderContext,
  mockResolveAdoProviderContext,
  mockSupportsDraftTransition,
  mockUpdateTaskPrStatus,
} = vi.hoisted(() => ({
  mockAcquireLifecycleLock: vi.fn(),
  mockCreateGitHubToken: vi.fn(),
  mockFindAssociation: vi.fn(),
  mockGetSetting: vi.fn(),
  mockGetPrAction: vi.fn(),
  mockGetOctokit: vi.fn(),
  mockGraphql: vi.fn(),
  mockPullRequestGet: vi.fn(),
  mockReleaseLifecycleLock: vi.fn(),
  mockResolveRepositoryRow: vi.fn(),
  mockResolveGitLabProviderContext: vi.fn(),
  mockResolveGiteaProviderContext: vi.fn(),
  mockResolveBitbucketProviderContext: vi.fn(),
  mockResolveAdoProviderContext: vi.fn(),
  mockSupportsDraftTransition: vi.fn(),
  mockUpdateTaskPrStatus: vi.fn(),
}));

vi.mock('@roomote/auth', () => ({
  createGitHubToken: (...args: unknown[]) => mockCreateGitHubToken(...args),
}));

vi.mock('@roomote/github', () => ({
  getOctokit: (...args: unknown[]) => mockGetOctokit(...args),
}));

vi.mock('@roomote/types', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/types')>()),
  supportsPullRequestDraftTransition: (...args: unknown[]) =>
    mockSupportsDraftTransition(...args),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...conditions: unknown[]) => ({ conditions })),
  eq: vi.fn((left: unknown, right: unknown) => ({ left, right })),
  db: {
    query: {
      taskPullRequests: { findFirst: mockFindAssociation },
    },
  },
  getDeploymentMarkRoomotePrReadyAfterCleanReview: (...args: unknown[]) =>
    mockGetSetting(...args),
  getDeploymentPrAction: (...args: unknown[]) => mockGetPrAction(...args),
  taskPullRequests: {
    sourceControlProvider: 'sourceControlProvider',
    repository: 'repository',
    repositoryId: 'repositoryId',
    prNumber: 'prNumber',
    createdByRoomote: 'createdByRoomote',
  },
}));

vi.mock('../update-task-pr-status', () => ({
  updateTaskPrStatus: (...args: unknown[]) => mockUpdateTaskPrStatus(...args),
}));

vi.mock('../source-control-pull-request-shared', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../source-control-pull-request-shared')
  >()),
  resolveRepositoryRow: (...args: unknown[]) =>
    mockResolveRepositoryRow(...args),
}));

vi.mock('../source-control-pull-request-provider-context', () => ({
  resolveGitLabProviderContext: (...args: unknown[]) =>
    mockResolveGitLabProviderContext(...args),
  resolveGiteaProviderContext: (...args: unknown[]) =>
    mockResolveGiteaProviderContext(...args),
  resolveBitbucketProviderContext: (...args: unknown[]) =>
    mockResolveBitbucketProviderContext(...args),
  resolveAdoProviderContext: (...args: unknown[]) =>
    mockResolveAdoProviderContext(...args),
}));

vi.mock('../../task-runs/github-pr-review-check', () => ({
  acquireGithubPrReviewLifecycleLock: (...args: unknown[]) =>
    mockAcquireLifecycleLock(...args),
}));

import { markRoomotePullRequestReadyAfterCleanReview } from '../mark-roomote-pull-request-ready';

const REVIEW_HEAD_SHA = '1234567890abcdef1234567890abcdef12345678';
const CLEAN_REVIEW = {
  outcome: 'clean',
  findingCount: 0,
  headSha: REVIEW_HEAD_SHA,
};

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      node_id: 'PR_node_id',
      state: 'open',
      draft: true,
      head: { sha: REVIEW_HEAD_SHA },
      ...overrides,
    },
  };
}

async function markReady(
  reviewResult: {
    outcome: string | null;
    findingCount: number | null;
    headSha: string | null;
  } = CLEAN_REVIEW,
  options: {
    provider?: 'github' | 'gitlab' | 'gitea' | 'ado' | 'bitbucket';
    fetchImpl?: typeof fetch;
  } = {},
) {
  return markRoomotePullRequestReadyAfterCleanReview({
    sourceControlProvider: options.provider ?? 'github',
    repository: 'owner/repo',
    prNumber: 42,
    reviewHeadSha: REVIEW_HEAD_SHA,
    reviewResult,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function responseQueue(...bodies: unknown[]) {
  return vi.fn(async () => jsonResponse(bodies.shift()));
}

describe('markRoomotePullRequestReadyAfterCleanReview', () => {
  beforeEach(() => {
    mockAcquireLifecycleLock
      .mockReset()
      .mockResolvedValue(mockReleaseLifecycleLock);
    mockCreateGitHubToken.mockReset().mockResolvedValue('token');
    mockFindAssociation.mockReset().mockResolvedValue({ id: 'association' });
    mockGetSetting.mockReset().mockResolvedValue(true);
    mockGetPrAction.mockReset().mockResolvedValue('draft');
    mockSupportsDraftTransition.mockReset().mockReturnValue(true);
    mockResolveRepositoryRow.mockReset().mockResolvedValue({
      id: 'repo-id',
      sourceControlProvider: 'github',
      host: 'github.com',
      installationId: '123',
      externalRepoId: 'project-id',
      fullName: 'owner/repo',
      htmlUrl: 'https://github.com/owner/repo',
    });
    mockResolveGitLabProviderContext.mockReset().mockResolvedValue({
      apiBaseUrl: 'https://gitlab.example/api/v4',
      projectId: 'project-id',
      token: 'gitlab-token',
    });
    mockResolveGiteaProviderContext.mockReset().mockResolvedValue({
      apiBaseUrl: 'https://gitea.example/api/v1',
      baseUrl: 'https://gitea.example',
      owner: 'owner',
      repo: 'repo',
      token: 'gitea-token',
    });
    mockResolveBitbucketProviderContext.mockReset().mockResolvedValue({
      apiBaseUrl: 'https://api.bitbucket.org/2.0',
      authHeader: 'Bearer bitbucket-token',
      baseUrl: 'https://bitbucket.org',
      workspace: 'owner',
      repo: 'repo',
    });
    mockResolveAdoProviderContext.mockReset().mockResolvedValue({
      baseUrl: 'https://dev.azure.com',
      organizationApiBaseUrl: 'https://dev.azure.com/org',
      repositoryPullRequestsPath:
        '/project/_apis/git/repositories/repo-id/pullrequests',
      token: 'ado-token',
    });
    mockGraphql.mockReset().mockResolvedValue({
      markPullRequestReadyForReview: {
        pullRequest: { headRefOid: REVIEW_HEAD_SHA, isDraft: false },
      },
    });
    mockPullRequestGet.mockReset().mockResolvedValue(pullRequest());
    mockUpdateTaskPrStatus.mockReset().mockResolvedValue(undefined);
    mockReleaseLifecycleLock.mockReset().mockResolvedValue(undefined);
    mockGetOctokit.mockReset().mockReturnValue({
      graphql: mockGraphql,
      rest: { pulls: { get: mockPullRequestGet } },
    });
  });

  it('does nothing when automatic ready promotion is disabled', async () => {
    mockGetSetting.mockResolvedValue(false);

    await expect(markReady()).resolves.toBe('disabled');
    expect(mockFindAssociation).not.toHaveBeenCalled();
    expect(mockPullRequestGet).not.toHaveBeenCalled();
  });

  it.each(['create', 'push'] as const)(
    'is inactive when pull request delivery is %s',
    async (prAction) => {
      mockGetPrAction.mockResolvedValue(prAction);

      await expect(markReady()).resolves.toBe('disabled');
      expect(mockFindAssociation).not.toHaveBeenCalled();
      expect(mockPullRequestGet).not.toHaveBeenCalled();
    },
  );

  it('fails closed when the provider lacks a ready transition capability', async () => {
    mockSupportsDraftTransition.mockReturnValue(false);

    await expect(markReady()).resolves.toBe('unsupported');
    expect(mockFindAssociation).not.toHaveBeenCalled();
    expect(mockPullRequestGet).not.toHaveBeenCalled();
  });

  it('marks a Roomote-created draft ready after a clean review', async () => {
    await expect(markReady()).resolves.toBe('marked_ready');

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining('markPullRequestReadyForReview'),
      { pullRequestId: 'PR_node_id' },
    );
    expect(mockUpdateTaskPrStatus).toHaveBeenCalledWith(
      'github',
      'owner/repo',
      42,
      'open',
    );
    expect(mockReleaseLifecycleLock).toHaveBeenCalledOnce();
  });

  it('converts the pull request back to draft when the mutation sees a newer head', async () => {
    mockGraphql
      .mockResolvedValueOnce({
        markPullRequestReadyForReview: {
          pullRequest: {
            headRefOid: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
            isDraft: false,
          },
        },
      })
      .mockResolvedValueOnce({
        convertPullRequestToDraft: { pullRequest: { isDraft: true } },
      });

    await expect(markReady()).resolves.toBe('head_changed');
    expect(mockGraphql).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('convertPullRequestToDraft'),
      { pullRequestId: 'PR_node_id' },
    );
    expect(mockUpdateTaskPrStatus).not.toHaveBeenCalled();
    expect(mockReleaseLifecycleLock).toHaveBeenCalledOnce();
  });

  it('surfaces a failed stale-head compensation for webhook retry', async () => {
    mockGraphql
      .mockResolvedValueOnce({
        markPullRequestReadyForReview: {
          pullRequest: {
            headRefOid: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
            isDraft: false,
          },
        },
      })
      .mockRejectedValueOnce(new Error('draft conversion failed'));

    await expect(markReady()).rejects.toThrow('draft conversion failed');
    expect(mockUpdateTaskPrStatus).not.toHaveBeenCalled();
    expect(mockReleaseLifecycleLock).toHaveBeenCalledOnce();
  });

  it('does not touch a human-created pull request', async () => {
    mockFindAssociation.mockResolvedValue(null);

    await expect(markReady()).resolves.toBe('not_roomote_created');
    expect(mockPullRequestGet).not.toHaveBeenCalled();
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it('scopes Roomote creation provenance to the resolved repository identity', async () => {
    await markReady();

    expect(mockFindAssociation).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          conditions: expect.arrayContaining([
            expect.objectContaining({ left: 'repositoryId', right: 'repo-id' }),
          ]),
        }),
      }),
    );
    expect(mockResolveRepositoryRow.mock.invocationCallOrder[0]).toBeLessThan(
      mockFindAssociation.mock.invocationCallOrder[0]!,
    );
  });

  it.each([
    { outcome: 'findings_remain', findingCount: 1, headSha: REVIEW_HEAD_SHA },
    { outcome: null, findingCount: null, headSha: REVIEW_HEAD_SHA },
    { outcome: 'clean', findingCount: 1, headSha: REVIEW_HEAD_SHA },
    { outcome: 'clean', findingCount: 0, headSha: 'different-head' },
  ])(
    'does not promote a non-clean or inconsistent review: %o',
    async (reviewResult) => {
      await expect(markReady(reviewResult)).resolves.toBe('review_not_clean');
      expect(mockFindAssociation).not.toHaveBeenCalled();
      expect(mockGraphql).not.toHaveBeenCalled();
    },
  );

  it('does not promote when the pull request head changed', async () => {
    mockPullRequestGet.mockResolvedValue(
      pullRequest({
        head: { sha: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd' },
      }),
    );

    await expect(markReady()).resolves.toBe('head_changed');
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it('does not promote from an abbreviated review head', async () => {
    const abbreviatedHead = REVIEW_HEAD_SHA.slice(0, 7);

    await expect(
      markRoomotePullRequestReadyAfterCleanReview({
        sourceControlProvider: 'github',
        repository: 'owner/repo',
        prNumber: 42,
        reviewHeadSha: abbreviatedHead,
        reviewResult: {
          ...CLEAN_REVIEW,
          headSha: abbreviatedHead,
        },
      }),
    ).resolves.toBe('head_changed');
    expect(mockGraphql).not.toHaveBeenCalled();
  });

  it('is a no-op when the pull request is already ready', async () => {
    mockPullRequestGet.mockResolvedValue(pullRequest({ draft: false }));

    await expect(markReady()).resolves.toBe('already_ready');
    expect(mockGraphql).not.toHaveBeenCalled();
    expect(mockUpdateTaskPrStatus).toHaveBeenCalledWith(
      'github',
      'owner/repo',
      42,
      'open',
    );
  });

  it('recovers when a concurrent retry already marked the pull request ready', async () => {
    mockGraphql.mockRejectedValueOnce(new Error('already ready'));
    mockPullRequestGet
      .mockResolvedValueOnce(pullRequest())
      .mockResolvedValueOnce(pullRequest({ draft: false }));

    await expect(markReady()).resolves.toBe('already_ready');
    expect(mockPullRequestGet).toHaveBeenCalledTimes(2);
    expect(mockUpdateTaskPrStatus).toHaveBeenCalledWith(
      'github',
      'owner/repo',
      42,
      'open',
    );
  });

  it('marks a GitLab draft merge request ready by removing its title prefix', async () => {
    const fetchImpl = responseQueue(
      {
        iid: 42,
        title: 'Draft: Add feature',
        state: 'opened',
        draft: true,
        sha: REVIEW_HEAD_SHA,
      },
      {
        iid: 42,
        title: 'Add feature',
        state: 'opened',
        draft: false,
        sha: REVIEW_HEAD_SHA,
      },
    );

    await expect(
      markReady(CLEAN_REVIEW, { provider: 'gitlab', fetchImpl }),
    ).resolves.toBe('marked_ready');
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ title: 'Add feature' }),
      }),
    );
    expect(mockUpdateTaskPrStatus).toHaveBeenCalledWith(
      'gitlab',
      'owner/repo',
      42,
      'open',
    );
  });

  it('marks a Gitea WIP pull request ready by removing its title prefix', async () => {
    const fetchImpl = responseQueue(
      {
        number: 42,
        title: 'WIP: Add feature',
        state: 'open',
        head: { sha: REVIEW_HEAD_SHA },
      },
      {
        number: 42,
        title: 'Add feature',
        state: 'open',
        head: { sha: REVIEW_HEAD_SHA },
      },
    );

    await expect(
      markReady(CLEAN_REVIEW, { provider: 'gitea', fetchImpl }),
    ).resolves.toBe('marked_ready');
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ title: 'Add feature' }),
      }),
    );
    expect(mockUpdateTaskPrStatus).toHaveBeenCalledWith(
      'gitea',
      'owner/repo',
      42,
      'open',
    );
  });

  it('fails closed for a Gitea native draft without title-prefix semantics', async () => {
    const fetchImpl = responseQueue({
      number: 42,
      title: 'Add feature',
      state: 'open',
      draft: true,
      head: { sha: REVIEW_HEAD_SHA },
    });

    await expect(
      markReady(CLEAN_REVIEW, { provider: 'gitea', fetchImpl }),
    ).resolves.toBe('unsupported');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(mockUpdateTaskPrStatus).not.toHaveBeenCalled();
  });

  it('fails closed when Gitea keeps its native draft flag after title update', async () => {
    const fetchImpl = responseQueue(
      {
        number: 42,
        title: 'WIP: Add feature',
        state: 'open',
        draft: true,
        head: { sha: REVIEW_HEAD_SHA },
      },
      {
        number: 42,
        title: 'Add feature',
        state: 'open',
        draft: true,
        head: { sha: REVIEW_HEAD_SHA },
      },
    );

    await expect(
      markReady(CLEAN_REVIEW, { provider: 'gitea', fetchImpl }),
    ).rejects.toThrow('Gitea did not confirm ready transition');
    expect(mockUpdateTaskPrStatus).not.toHaveBeenCalled();
  });

  it('marks a Bitbucket Cloud draft pull request ready', async () => {
    const pullRequest = (draft: boolean) => ({
      id: 42,
      title: 'Add feature',
      state: 'OPEN',
      draft,
      source: {
        branch: { name: 'feature' },
        commit: { hash: REVIEW_HEAD_SHA },
      },
    });
    const fetchImpl = responseQueue(pullRequest(true), pullRequest(false));

    await expect(
      markReady(CLEAN_REVIEW, { provider: 'bitbucket', fetchImpl }),
    ).resolves.toBe('marked_ready');
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ draft: false }),
      }),
    );
    expect(mockUpdateTaskPrStatus).toHaveBeenCalledWith(
      'bitbucket',
      'owner/repo',
      42,
      'open',
    );
  });

  it('marks an Azure DevOps draft pull request ready', async () => {
    const pullRequest = (isDraft: boolean) => ({
      pullRequestId: 42,
      title: 'Add feature',
      status: 'active',
      isDraft,
      lastMergeSourceCommit: { commitId: REVIEW_HEAD_SHA },
    });
    const fetchImpl = responseQueue(pullRequest(true), pullRequest(false));

    await expect(
      markReady(CLEAN_REVIEW, { provider: 'ado', fetchImpl }),
    ).resolves.toBe('marked_ready');
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ isDraft: false }),
      }),
    );
    expect(mockUpdateTaskPrStatus).toHaveBeenCalledWith(
      'ado',
      'owner/repo',
      42,
      'open',
    );
  });

  it('does not promote a closed pull request', async () => {
    mockPullRequestGet.mockResolvedValue(
      pullRequest({ state: 'closed', draft: true }),
    );

    await expect(markReady()).resolves.toBe('pull_request_not_open');
    expect(mockGraphql).not.toHaveBeenCalled();
    expect(mockUpdateTaskPrStatus).not.toHaveBeenCalled();
  });
});
