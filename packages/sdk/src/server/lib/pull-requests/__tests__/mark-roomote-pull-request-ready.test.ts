import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAcquireLifecycleLock,
  mockCreateGitHubToken,
  mockFindAssociation,
  mockGetSetting,
  mockGetOctokit,
  mockGraphql,
  mockPullRequestGet,
  mockReleaseLifecycleLock,
  mockUpdateTaskPrStatus,
} = vi.hoisted(() => ({
  mockAcquireLifecycleLock: vi.fn(),
  mockCreateGitHubToken: vi.fn(),
  mockFindAssociation: vi.fn(),
  mockGetSetting: vi.fn(),
  mockGetOctokit: vi.fn(),
  mockGraphql: vi.fn(),
  mockPullRequestGet: vi.fn(),
  mockReleaseLifecycleLock: vi.fn(),
  mockUpdateTaskPrStatus: vi.fn(),
}));

vi.mock('@roomote/auth', () => ({
  createGitHubToken: (...args: unknown[]) => mockCreateGitHubToken(...args),
}));

vi.mock('@roomote/github', () => ({
  getOctokit: (...args: unknown[]) => mockGetOctokit(...args),
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
  taskPullRequests: {
    sourceControlProvider: 'sourceControlProvider',
    repository: 'repository',
    prNumber: 'prNumber',
    createdByRoomote: 'createdByRoomote',
  },
}));

vi.mock('../update-task-pr-status', () => ({
  updateTaskPrStatus: (...args: unknown[]) => mockUpdateTaskPrStatus(...args),
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
) {
  return markRoomotePullRequestReadyAfterCleanReview({
    installationId: 123,
    repository: 'owner/repo',
    prNumber: 42,
    reviewHeadSha: REVIEW_HEAD_SHA,
    reviewResult,
  });
}

describe('markRoomotePullRequestReadyAfterCleanReview', () => {
  beforeEach(() => {
    mockAcquireLifecycleLock
      .mockReset()
      .mockResolvedValue(mockReleaseLifecycleLock);
    mockCreateGitHubToken.mockReset().mockResolvedValue('token');
    mockFindAssociation.mockReset().mockResolvedValue({ id: 'association' });
    mockGetSetting.mockReset().mockResolvedValue(true);
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
        installationId: 123,
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

  it('does not promote a closed pull request', async () => {
    mockPullRequestGet.mockResolvedValue(
      pullRequest({ state: 'closed', draft: true }),
    );

    await expect(markReady()).resolves.toBe('pull_request_not_open');
    expect(mockGraphql).not.toHaveBeenCalled();
    expect(mockUpdateTaskPrStatus).not.toHaveBeenCalled();
  });
});
