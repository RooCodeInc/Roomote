const mockQueueAdd = vi.fn();

vi.mock('@roomote/redis', () => ({ getRedis: vi.fn(() => ({})) }));
vi.mock('bullmq', () => ({
  Queue: class MockQueue {
    add = (...args: unknown[]) => mockQueueAdd(...args);
  },
}));

import {
  PULL_REQUEST_MERGEABILITY_INITIAL_DELAY_MS,
  PULL_REQUEST_MERGEABILITY_RETRY_DELAY_MS,
  enqueuePullRequestMergeabilityCheck,
} from '../pull-request-mergeability-check';

const request = {
  installationId: 123,
  repository: 'owner/repo',
  taskPullRequestIds: ['11111111-1111-4111-8111-111111111111'],
  deduplicationKey: 'base:owner/repo:main',
  retryAttempt: 0 as const,
  allowNotifiedConflictCheck: false,
};

describe('enqueuePullRequestMergeabilityCheck', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delays and trailing-edge deduplicates the first branch check', async () => {
    await enqueuePullRequestMergeabilityCheck(request);

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'check-pr-mergeability',
      request,
      {
        delay: PULL_REQUEST_MERGEABILITY_INITIAL_DELAY_MS,
        deduplication: {
          id: 'pr-mergeability:base:owner/repo:main:attempt-0',
          ttl: PULL_REQUEST_MERGEABILITY_INITIAL_DELAY_MS + 60_000,
          extend: true,
          replace: true,
        },
      },
    );
  });

  it('uses one distinct late-retry delay', async () => {
    await enqueuePullRequestMergeabilityCheck({
      ...request,
      retryAttempt: 1,
    });

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'check-pr-mergeability',
      expect.objectContaining({ retryAttempt: 1 }),
      expect.objectContaining({
        delay: PULL_REQUEST_MERGEABILITY_RETRY_DELAY_MS,
      }),
    );
  });
});
