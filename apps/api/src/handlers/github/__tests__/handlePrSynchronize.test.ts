import { TaskPayloadKind } from '@roomote/types';

import type { WebhookPullRequestSynchronize } from '../types';

const {
  mockAcquireGithubPrReviewLifecycleLock,
  mockEnqueueActivePrReviewFollowUp,
  mockPublishGithubPrReviewCheck,
  mockEnqueueTask,
  mockGetGitHubAutomationTargets,
  mockGetCurrentGitHubPrHeadSha,
  mockFindFirstLockedRun,
  mockReleaseLock,
  mockSelect,
  mockUpdate,
  mockUpdateSet,
  mockUpdateWhere,
} = vi.hoisted(() => ({
  mockAcquireGithubPrReviewLifecycleLock: vi.fn(),
  mockEnqueueActivePrReviewFollowUp: vi.fn(),
  mockPublishGithubPrReviewCheck: vi.fn(),
  mockEnqueueTask: vi.fn(),
  mockGetGitHubAutomationTargets: vi.fn(),
  mockGetCurrentGitHubPrHeadSha: vi.fn(),
  mockFindFirstLockedRun: vi.fn(),
  mockReleaseLock: vi.fn().mockResolvedValue(undefined),
  mockSelect: vi.fn(),
  mockUpdate: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockUpdateWhere: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  enqueueTask: (...args: unknown[]) => mockEnqueueTask(...args),
}));

vi.mock('../currentPrHead', () => ({
  getCurrentGitHubPrHeadSha: (...args: unknown[]) =>
    mockGetCurrentGitHubPrHeadSha(...args),
}));

vi.mock('@roomote/sdk/server', () => ({
  acquireGithubPrReviewLifecycleLock: (...args: unknown[]) =>
    mockAcquireGithubPrReviewLifecycleLock(...args),
  enqueueActivePrReviewFollowUp: (...args: unknown[]) =>
    mockEnqueueActivePrReviewFollowUp(...args),
  publishGithubPrReviewCheck: (...args: unknown[]) =>
    mockPublishGithubPrReviewCheck(...args),
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
      transaction: (callback: (tx: unknown) => unknown) =>
        callback({
          execute: vi.fn(),
          query: {
            taskRuns: {
              findFirst: (...args: unknown[]) =>
                mockFindFirstLockedRun(...args),
            },
          },
          update: (...args: unknown[]) => mockUpdate(...args),
        }),
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
  const query = {
    limit: vi.fn().mockResolvedValue(rows),
    orderBy: vi.fn(),
  };
  query.orderBy.mockReturnValue(query);

  return {
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue(query),
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
    mockAcquireGithubPrReviewLifecycleLock.mockResolvedValue(mockReleaseLock);
    mockEnqueueActivePrReviewFollowUp.mockResolvedValue(undefined);
    mockUpdate.mockReturnValue({ set: mockUpdateSet });
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockResolvedValue(undefined);
    mockGetCurrentGitHubPrHeadSha.mockResolvedValue('new-head');
    mockFindFirstLockedRun.mockResolvedValue({
      id: 100,
      taskId: 'task-100',
      status: 'pending',
      startedAt: null,
      sandboxServerUrl: null,
      payload: { repo: 'owner/repo', headSha: 'old-head' },
    });
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
          payload: { repo: 'owner/repo', headSha: 'old-head' },
        },
      ]),
    );

    await expect(handlePrSynchronize(payload)).resolves.toEqual({
      status: 'ok',
      message: 'A PR review is already active.',
    });

    expect(mockUpdateSet).toHaveBeenCalledWith({ prSha: 'new-head' });
    expect(mockUpdateSet).toHaveBeenCalledWith({
      payload: expect.objectContaining({
        headSha: 'new-head',
        branchName: 'feature',
      }),
    });
    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(mockEnqueueActivePrReviewFollowUp).not.toHaveBeenCalled();
    expect(mockReleaseLock).toHaveBeenCalledOnce();
  });

  it('debounces new commits onto the active OpenCode review', async () => {
    mockGetGitHubAutomationTargets.mockResolvedValueOnce({
      status: 'ok',
      targets: [
        {
          id: 'github:pr_review:repo-id',
          settings: { reviewOnCommit: true, publishGithubCheck: true },
          repo: { id: 'repo-id', host: 'github.com' },
          properties: {},
        },
      ],
    });
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
    // The superseding head is recorded before the debounced follow-up so a
    // review finishing inside that window is still seen as stale, while
    // `prSha` stays the head the review last covered (it seeds
    // `previous_review_head_sha` in the follow-up prompt).
    expect(mockUpdateSet).toHaveBeenCalledOnce();
    expect(mockUpdateSet).toHaveBeenCalledWith({
      payload: expect.anything(),
    });
    expect(mockUpdateSet).not.toHaveBeenCalledWith(
      expect.objectContaining({ prSha: expect.anything() }),
    );
    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(mockPublishGithubPrReviewCheck).toHaveBeenCalledWith({
      installationId: 1,
      repository: 'owner/repo',
      prNumber: 42,
      headSha: 'new-head',
      taskId: 'task-100',
      runId: 100,
      status: 'in_progress',
    });
    expect(mockReleaseLock).toHaveBeenCalledOnce();
  });

  it('queues a follow-up when a pending review starts during reconciliation', async () => {
    mockSelect.mockReturnValueOnce(
      selectResult([
        {
          id: 100,
          taskId: 'task-100',
          status: 'pending',
          startedAt: null,
          sandboxServerUrl: null,
          prSha: 'old-head',
          payload: { repo: 'owner/repo', headSha: 'old-head' },
        },
      ]),
    );
    mockFindFirstLockedRun.mockResolvedValueOnce({
      id: 100,
      taskId: 'task-100',
      status: 'running',
      startedAt: new Date(),
      sandboxServerUrl: 'http://sandbox.test',
      payload: { repo: 'owner/repo', headSha: 'old-head' },
    });

    await expect(handlePrSynchronize(payload)).resolves.toEqual({
      status: 'ok',
      message: 'Queued new PR changes on the active review.',
    });

    expect(mockEnqueueActivePrReviewFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 100,
        taskId: 'task-100',
        eventHeadSha: 'new-head',
      }),
    );
    expect(mockUpdateSet).not.toHaveBeenCalledWith(
      expect.objectContaining({ prSha: expect.anything() }),
    );
  });

  it('leaves the covered head unchanged when debounce scheduling fails', async () => {
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

    // Recording the superseding head is safe to retry; advancing `prSha`
    // would tell the next follow-up the review had already covered this push.
    expect(mockUpdateSet).not.toHaveBeenCalledWith(
      expect.objectContaining({ prSha: expect.anything() }),
    );
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

  it('queues a newer head as another run on the existing review task', async () => {
    mockGetGitHubAutomationTargets.mockResolvedValueOnce({
      status: 'ok',
      targets: [
        {
          id: 'github:pr_review:repo-id',
          settings: { reviewOnCommit: true, publishGithubCheck: true },
          repo: { id: 'repo-id', host: 'github.com' },
          properties: {},
        },
      ],
    });
    mockSelect
      .mockReturnValueOnce(selectResult([]))
      .mockReturnValueOnce(selectResult([]))
      .mockReturnValueOnce(selectResult([{ taskId: 'task-100' }]));
    mockEnqueueTask.mockResolvedValue({ id: 200, taskId: 'task-100' });

    await expect(handlePrSynchronize(payload)).resolves.toEqual({
      status: 'ok',
      metadata: { ids: [200] },
    });

    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        existingTaskId: 'task-100',
        task: expect.objectContaining({
          type: TaskPayloadKind.GithubPrReviewSync,
          payload: expect.objectContaining({ headSha: 'new-head' }),
        }),
      }),
    );
    expect(mockPublishGithubPrReviewCheck).toHaveBeenCalledWith({
      installationId: 1,
      repository: 'owner/repo',
      prNumber: 42,
      headSha: 'new-head',
      taskId: 'task-100',
      runId: 200,
    });
    expect(mockReleaseLock).toHaveBeenCalledOnce();
  });

  it('does not process a synchronize event when the live head is unavailable', async () => {
    mockGetCurrentGitHubPrHeadSha.mockResolvedValueOnce(null);

    await expect(handlePrSynchronize(payload)).rejects.toThrow(
      'Could not resolve the live head for owner/repo#42.',
    );

    expect(mockAcquireGithubPrReviewLifecycleLock).toHaveBeenCalledOnce();
    expect(mockReleaseLock).toHaveBeenCalledOnce();
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });
});
