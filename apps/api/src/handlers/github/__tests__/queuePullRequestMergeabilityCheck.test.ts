const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  list: vi.fn(),
  updateBaseRef: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  listTrackedPullRequestsForMergeability: (...args: unknown[]) =>
    mocks.list(...args),
  updateTrackedPullRequestBaseRef: (...args: unknown[]) =>
    mocks.updateBaseRef(...args),
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
    mocks.list.mockResolvedValue([
      { id: '11111111-1111-4111-8111-111111111111' },
    ]);
    mocks.updateBaseRef.mockResolvedValue(undefined);
    mocks.enqueue.mockResolvedValue(undefined);
  });

  it('queues one delayed branch batch containing only tracked candidates', async () => {
    await queueBaseBranchMergeabilityCheck({
      ref: 'refs/heads/main',
      installation: { id: 123 },
      repository: { full_name: 'owner/repo' },
    });

    expect(mocks.list).toHaveBeenCalledWith({
      repository: 'owner/repo',
      baseRef: 'main',
      skipNotifiedConflicts: true,
    });
    expect(mocks.enqueue).toHaveBeenCalledWith({
      installationId: 123,
      repository: 'owner/repo',
      taskPullRequestIds: ['11111111-1111-4111-8111-111111111111'],
      deduplicationKey: 'base:owner/repo:main',
      retryAttempt: 0,
      allowNotifiedConflictCheck: false,
    });
  });

  it('updates an edited base and queues only the affected tracked PR', async () => {
    await queueTrackedPullRequestMergeabilityCheck({
      installation: { id: 123 },
      repository: { full_name: 'owner/repo' },
      pull_request: { number: 42, base: { ref: 'release' } },
    });

    expect(mocks.updateBaseRef).toHaveBeenCalledWith({
      repository: 'owner/repo',
      prNumber: 42,
      baseRef: 'release',
    });
    expect(mocks.list).toHaveBeenCalledWith({
      repository: 'owner/repo',
      prNumber: 42,
    });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        deduplicationKey: 'pr:owner/repo:42',
        allowNotifiedConflictCheck: true,
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
});
