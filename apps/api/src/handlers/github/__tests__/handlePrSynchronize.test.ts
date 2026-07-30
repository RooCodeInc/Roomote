import type { WebhookPullRequestSynchronize } from '../types';

const {
  mockAcquireRedisLock,
  mockEnqueueTask,
  mockGetGitHubAutomationTargets,
  mockReleaseLock,
  mockSelect,
} = vi.hoisted(() => ({
  mockAcquireRedisLock: vi.fn(),
  mockEnqueueTask: vi.fn(),
  mockGetGitHubAutomationTargets: vi.fn(),
  mockReleaseLock: vi.fn().mockResolvedValue(undefined),
  mockSelect: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({
  acquireRedisLock: (...args: unknown[]) => mockAcquireRedisLock(...args),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: (...args: unknown[]) => mockEnqueueTask(...args),
}));

vi.mock('@roomote/db/server', async () => {
  const actual =
    await vi.importActual<typeof import('@roomote/db/server')>(
      '@roomote/db/server',
    );

  return {
    ...actual,
    db: { select: (...args: unknown[]) => mockSelect(...args) },
  };
});

vi.mock('../getGitHubAutomationTargets', () => ({
  getGitHubAutomationTargets: (...args: unknown[]) =>
    mockGetGitHubAutomationTargets(...args),
}));

vi.mock('../backgroundGithubTaskProperties', () => ({
  getBackgroundGithubTaskProperties: vi.fn().mockReturnValue({}),
}));

vi.mock('../reviewTaskRelayPayload', () => ({
  getReviewTaskRelayPayload: vi.fn().mockResolvedValue({}),
}));

import { handlePrSynchronize } from '../handlePrSynchronize';

function selectResult(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

const payload = {
  installation: { id: 1 },
  repository: { id: 2, full_name: 'owner/repo' },
  pull_request: {
    number: 42,
    title: 'Update feature',
    html_url: 'https://github.com/owner/repo/pull/42',
    body: null,
    draft: false,
    locked: false,
    user: { login: 'roomote-user' },
    head: { ref: 'feature', sha: 'new-head' },
    base: { ref: 'main', sha: 'base-sha' },
  },
  sender: { id: 3, login: 'roomote-user' },
} as unknown as WebhookPullRequestSynchronize;

describe('handlePrSynchronize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAcquireRedisLock.mockResolvedValue(mockReleaseLock);
    mockGetGitHubAutomationTargets.mockResolvedValue({
      status: 'ok',
      targets: [
        {
          id: 'github:pr_review:repo-id',
          settings: { reviewOnCommit: true },
          repo: { id: 'repo-id', host: 'github.com' },
          properties: {},
        },
      ],
    });
  });

  it('keeps the existing non-terminal review and prevents a new run', async () => {
    mockSelect.mockReturnValueOnce(selectResult([{ id: 100 }]));

    await expect(handlePrSynchronize(payload)).resolves.toEqual({
      status: 'ok',
      message: 'A PR review is already active.',
    });

    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(mockReleaseLock).toHaveBeenCalledOnce();
  });
});
