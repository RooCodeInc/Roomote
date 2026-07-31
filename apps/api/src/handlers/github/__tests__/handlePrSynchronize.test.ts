import type { WebhookPullRequestSynchronize } from '../types';

const {
  mockAcquireRedisLock,
  mockEnqueueActivePrReviewFollowUp,
  mockEnqueueTask,
  mockGetGitHubAutomationTargets,
  mockReleaseLock,
  mockSelect,
  mockUpdate,
  mockUpdateSet,
  mockUpdateWhere,
} = vi.hoisted(() => ({
  mockAcquireRedisLock: vi.fn(),
  mockEnqueueActivePrReviewFollowUp: vi.fn(),
  mockEnqueueTask: vi.fn(),
  mockGetGitHubAutomationTargets: vi.fn(),
  mockReleaseLock: vi.fn().mockResolvedValue(undefined),
  mockSelect: vi.fn(),
  mockUpdate: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockUpdateWhere: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({
  acquireRedisLock: (...args: unknown[]) => mockAcquireRedisLock(...args),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: (...args: unknown[]) => mockEnqueueTask(...args),
}));

vi.mock('@roomote/sdk/server', () => ({
  enqueueActivePrReviewFollowUp: (...args: unknown[]) =>
    mockEnqueueActivePrReviewFollowUp(...args),
}));

vi.mock('@roomote/db/server', async () => {
  const actual =
    await vi.importActual<typeof import('@roomote/db/server')>(
      '@roomote/db/server',
    );

  return {
    ...actual,
    db: {
      select: (...args: unknown[]) => mockSelect(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
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
    mockEnqueueActivePrReviewFollowUp.mockResolvedValue(undefined);
    mockUpdate.mockReturnValue({ set: mockUpdateSet });
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockResolvedValue(undefined);
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
    mockSelect.mockReturnValueOnce(
      selectResult([
        {
          id: 100,
          taskId: 'task-100',
          status: 'running',
          startedAt: new Date(),
          sandboxServerUrl: 'http://sandbox.test',
          prSha: 'new-head',
        },
      ]),
    );

    await expect(handlePrSynchronize(payload)).resolves.toEqual({
      status: 'ok',
      message: 'A PR review is already active.',
    });

    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(mockEnqueueActivePrReviewFollowUp).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockReleaseLock).toHaveBeenCalledOnce();
  });

  it('moves a pending canonical review linkage to the newest head', async () => {
    mockSelect.mockReturnValueOnce(
      selectResult([
        {
          id: 100,
          taskId: 'task-100',
          status: 'pending',
          startedAt: null,
          sandboxServerUrl: null,
          prSha: 'old-head',
        },
      ]),
    );

    await expect(handlePrSynchronize(payload)).resolves.toEqual({
      status: 'ok',
      message: 'A PR review is already active.',
    });

    expect(mockUpdateSet).toHaveBeenCalledWith({ prSha: 'new-head' });
    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(mockEnqueueActivePrReviewFollowUp).not.toHaveBeenCalled();
    expect(mockReleaseLock).toHaveBeenCalledOnce();
  });

  it('debounces new commits onto the active OpenCode review', async () => {
    mockSelect.mockReturnValueOnce(
      selectResult([
        {
          id: 100,
          taskId: 'task-100',
          status: 'running',
          startedAt: new Date(),
          sandboxServerUrl: 'http://sandbox.test',
          prSha: 'old-head',
        },
      ]),
    );

    await expect(handlePrSynchronize(payload)).resolves.toEqual({
      status: 'ok',
      message: 'Queued new PR changes on the active review.',
    });

    expect(mockEnqueueActivePrReviewFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 100,
        taskId: 'task-100',
        sandboxServerUrl: 'http://sandbox.test',
        repository: 'owner/repo',
        prNumber: 42,
        previousHeadSha: 'old-head',
        eventHeadSha: 'new-head',
        fallback: expect.objectContaining({
          task: expect.objectContaining({
            type: 'github_pr_review_sync',
            payload: expect.objectContaining({ headSha: 'new-head' }),
          }),
        }),
      }),
    );
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(mockReleaseLock).toHaveBeenCalledOnce();
  });

  it('leaves the stored head unchanged when debounce scheduling fails', async () => {
    mockSelect.mockReturnValueOnce(
      selectResult([
        {
          id: 100,
          taskId: 'task-100',
          status: 'running',
          startedAt: new Date(),
          sandboxServerUrl: 'http://sandbox.test',
          prSha: 'old-head',
        },
      ]),
    );
    mockEnqueueActivePrReviewFollowUp.mockRejectedValueOnce(
      new Error('queue unavailable'),
    );

    await expect(handlePrSynchronize(payload)).rejects.toThrow(
      'queue unavailable',
    );

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(mockReleaseLock).toHaveBeenCalledOnce();
  });

  it('does not enqueue another review for a completed review of the same head', async () => {
    mockSelect
      .mockReturnValueOnce(selectResult([]))
      .mockReturnValueOnce(selectResult([{ id: 100 }]));

    await expect(handlePrSynchronize(payload)).resolves.toEqual({
      status: 'ok',
      message: 'PR head SHA already matches the latest reviewed SHA.',
    });

    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(mockReleaseLock).toHaveBeenCalledOnce();
  });
});
