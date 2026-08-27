const { mockQueueAdd, mockQueueConstructor } = vi.hoisted(() => ({
  mockQueueAdd: vi.fn(),
  mockQueueConstructor: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({
  getRedis: vi.fn(() => ({})),
}));

vi.mock('bullmq', () => ({
  Queue: class MockQueue {
    constructor(...args: unknown[]) {
      mockQueueConstructor(...args);
    }

    add = (...args: unknown[]) => mockQueueAdd(...args);
  },
}));

import {
  ACTIVE_PR_REVIEW_FOLLOW_UP_DEBOUNCE_MS,
  ACTIVE_PR_REVIEW_FOLLOW_UP_DEDUPLICATION_TTL_MS,
  ACTIVE_PR_REVIEW_FOLLOW_UP_JOB_OPTIONS,
  ACTIVE_PR_REVIEW_FOLLOW_UP_QUEUE_NAME,
  ACTIVE_PR_REVIEW_FOLLOW_UP_RETRY_WINDOW_MS,
  enqueueActivePrReviewFollowUp,
} from '@roomote/sdk/server';
import { WORKER_HEARTBEAT_STALE_MS } from '@roomote/types';

const request = {
  runId: 100,
  taskId: 'task-100',
  sandboxServerUrl: 'https://sandbox.example.test',
  repository: 'owner/repo',
  prNumber: 42,
  previousHeadSha: 'old-head',
  eventHeadSha: 'new-head',
  fallback: {
    task: {
      type: 'github_pr_review_sync' as const,
      payload: {
        repo: 'owner/repo',
        prNumber: 42,
        prTitle: 'Update feature',
        prUrl: 'https://github.com/owner/repo/pull/42',
        headSha: 'new-head',
      },
    },
    initiatorActor: { externalId: '3', displayName: 'roomote-user' },
    prLinkage: {
      provider: 'github' as const,
      host: 'github.com',
      repositoryId: 'repo-id',
      repository: 'owner/repo',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      prTitle: 'Update feature',
      prSha: 'new-head',
      prBaseRef: 'main',
      prBaseSha: 'base-head',
    },
  },
};

describe('enqueueActivePrReviewFollowUp', () => {
  it('uses trailing-edge replacement for one active review run', async () => {
    await enqueueActivePrReviewFollowUp(request);

    expect(mockQueueConstructor).toHaveBeenCalledWith(
      ACTIVE_PR_REVIEW_FOLLOW_UP_QUEUE_NAME,
      expect.objectContaining({
        defaultJobOptions: ACTIVE_PR_REVIEW_FOLLOW_UP_JOB_OPTIONS,
      }),
    );

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'queue-active-pr-review-follow-up',
      request,
      {
        delay: ACTIVE_PR_REVIEW_FOLLOW_UP_DEBOUNCE_MS,
        deduplication: {
          id: 'active-pr-review-follow-up:100',
          ttl: ACTIVE_PR_REVIEW_FOLLOW_UP_DEDUPLICATION_TTL_MS,
          extend: true,
          replace: true,
        },
      },
    );
  });

  it('retries beyond stale-worker detection and its scheduler cadence', () => {
    expect(ACTIVE_PR_REVIEW_FOLLOW_UP_RETRY_WINDOW_MS).toBeGreaterThanOrEqual(
      WORKER_HEARTBEAT_STALE_MS + 2 * 60 * 1000,
    );
  });

  it('replaces a retry-delayed follow-up with the newest pushed head', async () => {
    const latestRequest = {
      ...request,
      eventHeadSha: 'newest-head',
      fallback: {
        ...request.fallback,
        task: {
          ...request.fallback.task,
          payload: {
            ...request.fallback.task.payload,
            headSha: 'newest-head',
          },
        },
        prLinkage: {
          ...request.fallback.prLinkage,
          prSha: 'newest-head',
        },
      },
    };

    await enqueueActivePrReviewFollowUp(request);
    await enqueueActivePrReviewFollowUp(latestRequest);

    expect(mockQueueAdd).toHaveBeenLastCalledWith(
      'queue-active-pr-review-follow-up',
      latestRequest,
      {
        delay: ACTIVE_PR_REVIEW_FOLLOW_UP_DEBOUNCE_MS,
        deduplication: {
          id: 'active-pr-review-follow-up:100',
          ttl: ACTIVE_PR_REVIEW_FOLLOW_UP_DEDUPLICATION_TTL_MS,
          extend: true,
          replace: true,
        },
      },
    );
    expect(ACTIVE_PR_REVIEW_FOLLOW_UP_DEDUPLICATION_TTL_MS).toBeGreaterThan(
      ACTIVE_PR_REVIEW_FOLLOW_UP_RETRY_WINDOW_MS,
    );
  });
});
