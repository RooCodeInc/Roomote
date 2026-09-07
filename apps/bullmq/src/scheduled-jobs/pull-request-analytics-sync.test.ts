const mocks = vi.hoisted(() => ({
  enrichPullRequestFacts: vi.fn(),
  syncGitHubPullRequestFactsForAllOrgs: vi.fn(),
  syncSourceControlPullRequestFacts: vi.fn(),
  queueAdd: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  enrichPullRequestFacts: mocks.enrichPullRequestFacts,
  syncGitHubPullRequestFactsForAllOrgs:
    mocks.syncGitHubPullRequestFactsForAllOrgs,
  syncSourceControlPullRequestFacts: mocks.syncSourceControlPullRequestFacts,
}));

vi.mock('../redis', () => ({
  getRedis: () => ({}),
}));

vi.mock('bullmq', () => ({
  Queue: class MockQueue {
    add = (...args: unknown[]) => mocks.queueAdd(...args);
  },
}));

import {
  pullRequestAnalyticsSyncJob,
  resetPullRequestAnalyticsFollowUpQueueForTests,
} from './pull-request-analytics-sync';

const emptyResult = {
  eligibleRepositories: 0,
  processedRepositories: 0,
  failedRepositories: 0,
  cooledDownRepositories: 0,
};

describe('pullRequestAnalyticsSyncJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPullRequestAnalyticsFollowUpQueueForTests();
    mocks.syncGitHubPullRequestFactsForAllOrgs.mockResolvedValue([]);
    mocks.syncSourceControlPullRequestFacts.mockResolvedValue(emptyResult);
    mocks.enrichPullRequestFacts.mockResolvedValue(undefined);
    mocks.queueAdd.mockResolvedValue(undefined);
  });

  it('chains a BrainCollectors follow-up when asked, before enrichment', async () => {
    const order: string[] = [];
    mocks.queueAdd.mockImplementation(async () => {
      order.push('follow-up');
    });
    mocks.enrichPullRequestFacts.mockImplementation(async () => {
      order.push('enrich');
    });

    await pullRequestAnalyticsSyncJob({ chainBrainCollectors: true });

    expect(mocks.queueAdd).toHaveBeenCalledWith(
      'BrainCollectors',
      { reason: 'pull-request-analytics-sync' },
      expect.objectContaining({
        jobId: expect.stringMatching(/^brain-collectors-post-pr-sync-\d+$/),
      }),
    );
    expect(order).toEqual(['follow-up', 'enrich']);
  });

  it('does not chain on a plain scheduled run', async () => {
    await pullRequestAnalyticsSyncJob();

    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  it('swallows follow-up enqueue failures', async () => {
    mocks.queueAdd.mockRejectedValue(new Error('redis down'));

    await expect(
      pullRequestAnalyticsSyncJob({ chainBrainCollectors: true }),
    ).resolves.toBeUndefined();
    expect(mocks.enrichPullRequestFacts).toHaveBeenCalled();
  });
});
