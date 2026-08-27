const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  isRepoSkipped: vi.fn(),
  list: vi.fn(),
  updateBaseRef: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  listTrackedPullRequestsForMergeability: (...args: unknown[]) =>
    mocks.list(...args),
  updateTrackedPullRequestBaseRef: (...args: unknown[]) =>
    mocks.updateBaseRef(...args),
}));

vi.mock('@roomote/github', () => ({
  isRepoSkipped: (...args: unknown[]) => mocks.isRepoSkipped(...args),
}));

vi.mock('@roomote/sdk/server', () => ({
  enqueuePullRequestMergeabilityCheck: (...args: unknown[]) =>
    mocks.enqueue(...args),
}));

import {
  queueBaseBranchMergeabilityCheck,
  queueTrackedPullRequestMergeabilityCheck,
} from '../queuePullRequestMergeabilityCheck';

describe('queuePullRequestMergeabilityCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isRepoSkipped.mockReturnValue(false);
    mocks.list.mockResolvedValue([
      { id: '11111111-1111-4111-8111-111111111111' },
    ]);
    mocks.updateBaseRef.mockResolvedValue(undefined);
    mocks.enqueue.mockResolvedValue(undefined);
  });

  it('enqueues a branch-scoped check so the job resolves candidates at run time', async () => {
    await queueBaseBranchMergeabilityCheck({
      ref: 'refs/heads/main',
      installation: { id: 123 },
      repository: { full_name: 'owner/repo' },
    });

    expect(mocks.list).toHaveBeenCalledWith({
      repository: 'owner/repo',
      baseRef: 'main',
    });
    expect(mocks.enqueue).toHaveBeenCalledWith({
      installationId: 123,
      repository: 'owner/repo',
      baseRef: 'main',
      deduplicationKey: 'base:owner/repo:main',
      retryAttempt: 0,
      allowNotifiedConflictCheck: true,
    });
  });

  it('enqueues a PR-scoped check without listing, so opened webhooks racing the tracked-row insert still get checked', async () => {
    await queueTrackedPullRequestMergeabilityCheck({
      installation: { id: 123 },
      repository: { full_name: 'owner/repo' },
      pull_request: { number: 42, base: { ref: 'main' } },
    });

    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.updateBaseRef).not.toHaveBeenCalled();
    expect(mocks.enqueue).toHaveBeenCalledWith({
      installationId: 123,
      repository: 'owner/repo',
      prNumber: 42,
      deduplicationKey: 'pr:owner/repo:42',
      retryAttempt: 0,
      allowNotifiedConflictCheck: true,
    });
  });

  it('updates the base ref only when the caller reports a base change', async () => {
    await queueTrackedPullRequestMergeabilityCheck(
      {
        installation: { id: 123 },
        repository: { full_name: 'owner/repo' },
        pull_request: { number: 42, base: { ref: 'release' } },
      },
      { updateBaseRef: true },
    );

    expect(mocks.updateBaseRef).toHaveBeenCalledWith({
      repository: 'owner/repo',
      prNumber: 42,
      baseRef: 'release',
    });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        prNumber: 42,
        deduplicationKey: 'pr:owner/repo:42',
      }),
    );
  });

  it('does not enqueue when the pushed branch has no tracked PRs', async () => {
    mocks.list.mockResolvedValue([]);

    await queueBaseBranchMergeabilityCheck({
      ref: 'refs/heads/main',
      installation: { id: 123 },
      repository: { full_name: 'owner/repo' },
    });

    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('honors isRepoSkipped on both paths', async () => {
    mocks.isRepoSkipped.mockReturnValue(true);

    await queueBaseBranchMergeabilityCheck({
      ref: 'refs/heads/main',
      installation: { id: 123 },
      repository: { full_name: 'owner/repo' },
    });
    await queueTrackedPullRequestMergeabilityCheck({
      installation: { id: 123 },
      repository: { full_name: 'owner/repo' },
      pull_request: { number: 42, base: { ref: 'main' } },
    });

    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('swallows queueing failures so the webhook delivery and its other handlers survive', async () => {
    mocks.enqueue.mockRejectedValue(new Error('redis down'));

    await expect(
      queueBaseBranchMergeabilityCheck({
        ref: 'refs/heads/main',
        installation: { id: 123 },
        repository: { full_name: 'owner/repo' },
      }),
    ).resolves.toBeUndefined();
    await expect(
      queueTrackedPullRequestMergeabilityCheck({
        installation: { id: 123 },
        repository: { full_name: 'owner/repo' },
        pull_request: { number: 42, base: { ref: 'main' } },
      }),
    ).resolves.toBeUndefined();
  });
});
