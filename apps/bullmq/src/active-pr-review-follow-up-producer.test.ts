const mockQueueAdd = vi.fn();

vi.mock('@roomote/redis', () => ({
  getRedis: vi.fn(() => ({})),
}));

vi.mock('bullmq', () => ({
  Queue: class MockQueue {
    add = (...args: unknown[]) => mockQueueAdd(...args);
  },
}));

import {
  ACTIVE_PR_REVIEW_FOLLOW_UP_DEBOUNCE_MS,
  enqueueActivePrReviewFollowUp,
} from '@roomote/sdk/server';

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

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'queue-active-pr-review-follow-up',
      request,
      {
        delay: ACTIVE_PR_REVIEW_FOLLOW_UP_DEBOUNCE_MS,
        deduplication: {
          id: 'active-pr-review-follow-up:100',
          ttl: ACTIVE_PR_REVIEW_FOLLOW_UP_DEBOUNCE_MS,
          extend: true,
          replace: true,
        },
      },
    );
  });
});
