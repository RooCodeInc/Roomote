import { z } from 'zod';

const {
  mockBuildPrompt,
  mockEnqueueTask,
  mockFindFirstRun,
  mockGetTaskGoalForRun,
  mockSendPrompt,
  mockUpdateWhere,
  mockWithSandboxServerRpcClient,
  mockAcquireGithubPrReviewLifecycleLock,
  mockReleaseGithubPrReviewLifecycleLock,
  mockTransferGithubPrReviewCheckToRun,
} = vi.hoisted(() => ({
  mockBuildPrompt: vi.fn(),
  mockEnqueueTask: vi.fn(),
  mockFindFirstRun: vi.fn(),
  mockGetTaskGoalForRun: vi.fn(),
  mockSendPrompt: vi.fn(),
  mockUpdateWhere: vi.fn(),
  mockWithSandboxServerRpcClient: vi.fn(),
  mockAcquireGithubPrReviewLifecycleLock: vi.fn(),
  mockReleaseGithubPrReviewLifecycleLock: Object.assign(vi.fn(), {
    signal: new AbortController().signal,
  }),
  mockTransferGithubPrReviewCheckToRun: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  buildGitHubPrSynchronizeFollowUpMessage: (...args: unknown[]) =>
    mockBuildPrompt(...args),
  enqueueTask: (...args: unknown[]) => mockEnqueueTask(...args),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: {
        findFirst: (...args: unknown[]) => mockFindFirstRun(...args),
      },
    },
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: (...args: unknown[]) => mockUpdateWhere(...args),
      })),
    })),
  },
  eq: vi.fn((...args: unknown[]) => args),
  getTaskGoalForRun: (...args: unknown[]) => mockGetTaskGoalForRun(...args),
  taskPullRequests: { taskId: 'taskPullRequests.taskId' },
  taskRuns: { id: 'taskRuns.id' },
}));

vi.mock('@roomote/sdk/server', () => ({
  activePrReviewFollowUpRequestSchema: z.object({
    installationId: z.number().optional(),
    runId: z.number(),
    taskId: z.string(),
    sandboxServerUrl: z.string(),
    repository: z.string(),
    prNumber: z.number(),
    previousHeadSha: z.string().nullable(),
    eventHeadSha: z.string(),
    fallback: z.any(),
  }),
  acquireGithubPrReviewLifecycleLock: (...args: unknown[]) =>
    mockAcquireGithubPrReviewLifecycleLock(...args),
  transferGithubPrReviewCheckToRun: (...args: unknown[]) =>
    mockTransferGithubPrReviewCheckToRun(...args),
  withSandboxServerRpcClient: (...args: unknown[]) =>
    mockWithSandboxServerRpcClient(...args),
}));

import type { Job } from 'bullmq';

import { RunStatus, TaskPayloadKind } from '@roomote/types';

import { activePrReviewFollowUpJob } from './active-pr-review-follow-up';

const data = {
  installationId: 1,
  runId: 100,
  taskId: 'task-100',
  sandboxServerUrl: 'https://sandbox.example.test',
  repository: 'owner/repo',
  prNumber: 42,
  previousHeadSha: 'old-head',
  eventHeadSha: 'new-head',
  fallback: {
    task: {
      type: TaskPayloadKind.GithubPrReviewSync,
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
      repository: 'owner/repo',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      prSha: 'new-head',
    },
  },
};

function makeJob() {
  return { data } as unknown as Job<typeof data, void, string>;
}

describe('activePrReviewFollowUpJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildPrompt.mockReturnValue('Review the latest live PR head.');
    mockEnqueueTask.mockResolvedValue({ id: 200 });
    mockSendPrompt.mockResolvedValue({ success: true });
    mockGetTaskGoalForRun.mockResolvedValue(null);
    mockUpdateWhere.mockResolvedValue(undefined);
    mockWithSandboxServerRpcClient.mockImplementation(
      ({ call }: { call: (client: unknown) => Promise<unknown> }) =>
        call({ commands: { sendPrompt: { mutate: mockSendPrompt } } }),
    );
    mockAcquireGithubPrReviewLifecycleLock.mockResolvedValue(
      mockReleaseGithubPrReviewLifecycleLock,
    );
    mockTransferGithubPrReviewCheckToRun.mockResolvedValue(undefined);
  });

  it('sends a hidden follow-up that keeps the active task alive', async () => {
    mockFindFirstRun.mockResolvedValue({
      id: 100,
      taskId: 'task-100',
      status: RunStatus.Running,
      sandboxServerUrl: 'https://sandbox.example.test',
      snapshotId: null,
      snapshotCreatedAt: null,
      port: null,
      payload: { repo: 'owner/repo' },
      actingUserId: null,
    });

    await activePrReviewFollowUpJob(makeJob());

    expect(mockSendPrompt).toHaveBeenCalledWith({
      prompt: 'Review the latest live PR head.',
      source: 'github-pr-synchronize',
      clientMessageId: 'github-pr-synchronize:100:owner/repo:42',
      visibleInTranscript: false,
    });
    expect(mockUpdateWhere).toHaveBeenCalledOnce();
    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(mockTransferGithubPrReviewCheckToRun).not.toHaveBeenCalled();
  });

  it('includes active goal context in a live review follow-up', async () => {
    const goal = {
      objective: 'Finish reviewing the pull request',
      generation: 'goal-generation:review',
      status: 'active' as const,
      maxContinuations: 5,
      continuationsUsed: 1,
      blockedReason: null,
      completedAt: null,
    };
    mockFindFirstRun.mockResolvedValue({
      id: 100,
      taskId: 'task-100',
      status: RunStatus.Running,
      sandboxServerUrl: 'https://sandbox.example.test',
      snapshotId: null,
      snapshotCreatedAt: null,
      port: null,
      payload: { repo: 'owner/repo' },
      actingUserId: null,
    });
    mockGetTaskGoalForRun.mockResolvedValue(goal);

    await activePrReviewFollowUpJob(makeJob());

    expect(mockGetTaskGoalForRun).toHaveBeenCalledWith(100);
    expect(mockSendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ goalContext: goal }),
    );
  });

  it('keeps a failed live delivery retryable without advancing the PR head', async () => {
    mockFindFirstRun.mockResolvedValue({
      id: 100,
      taskId: 'task-100',
      status: RunStatus.Running,
      sandboxServerUrl: 'https://sandbox.example.test',
      snapshotId: null,
      snapshotCreatedAt: null,
      port: null,
      payload: { repo: 'owner/repo' },
      actingUserId: null,
    });
    mockWithSandboxServerRpcClient.mockRejectedValue(
      new TypeError('fetch failed'),
    );

    await expect(activePrReviewFollowUpJob(makeJob())).rejects.toThrow(
      'fetch failed',
    );

    expect(mockUpdateWhere).not.toHaveBeenCalled();
    expect(mockEnqueueTask).not.toHaveBeenCalled();
  });

  it('resumes after a retry observes that the unreachable run finished', async () => {
    mockFindFirstRun
      .mockResolvedValueOnce({
        id: 100,
        taskId: 'task-100',
        status: RunStatus.Running,
        sandboxServerUrl: 'https://sandbox.example.test',
        snapshotId: null,
        snapshotCreatedAt: null,
        port: null,
        payload: { repo: 'owner/repo' },
        actingUserId: null,
      })
      .mockResolvedValueOnce({
        id: 100,
        taskId: 'task-100',
        status: RunStatus.Completed,
        sandboxServerUrl: null,
        snapshotId: 'snapshot-100',
        snapshotCreatedAt: new Date(),
        port: 3000,
        payload: { repo: 'owner/repo' },
        actingUserId: 'user-1',
      });
    mockWithSandboxServerRpcClient.mockRejectedValueOnce(
      new TypeError('fetch failed'),
    );

    await expect(activePrReviewFollowUpJob(makeJob())).rejects.toThrow(
      'fetch failed',
    );
    await activePrReviewFollowUpJob(makeJob());

    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: TaskPayloadKind.SnapshotResume,
          sourceRunId: 100,
          payload: expect.objectContaining({
            sourceSnapshotId: 'snapshot-100',
            resumePromptClientMessageId:
              'github-pr-synchronize:100:owner/repo:42',
          }),
        }),
      }),
    );
    expect(mockUpdateWhere).toHaveBeenCalledOnce();
    expect(mockTransferGithubPrReviewCheckToRun).toHaveBeenCalledWith({
      installationId: 1,
      repository: 'owner/repo',
      prNumber: 42,
      taskId: 'task-100',
      previousRunId: 100,
      newRunId: 200,
      signal: mockReleaseGithubPrReviewLifecycleLock.signal,
    });
    expect(mockEnqueueTask.mock.invocationCallOrder[0]).toBeLessThan(
      mockTransferGithubPrReviewCheckToRun.mock.invocationCallOrder[0]!,
    );
    expect(
      mockTransferGithubPrReviewCheckToRun.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mockReleaseGithubPrReviewLifecycleLock.mock.invocationCallOrder[0]!,
    );
  });

  it('resumes the same task when the active review finishes during debounce', async () => {
    mockFindFirstRun.mockResolvedValue({
      id: 100,
      taskId: 'task-100',
      status: RunStatus.Completed,
      sandboxServerUrl: null,
      snapshotId: 'snapshot-100',
      snapshotCreatedAt: new Date(),
      port: 3000,
      payload: { repo: 'owner/repo', environmentId: undefined },
      actingUserId: 'user-1',
    });

    await activePrReviewFollowUpJob(makeJob());

    expect(mockEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          type: TaskPayloadKind.SnapshotResume,
          sourceRunId: 100,
          payload: expect.objectContaining({
            sourceSnapshotId: 'snapshot-100',
            resumePrompt: 'Review the latest live PR head.',
          }),
        }),
        actingUserId: 'user-1',
      }),
    );
    expect(mockUpdateWhere).toHaveBeenCalledOnce();
    expect(mockTransferGithubPrReviewCheckToRun).toHaveBeenCalledWith(
      expect.objectContaining({
        previousRunId: 100,
        newRunId: 200,
      }),
    );
    expect(mockSendPrompt).not.toHaveBeenCalled();
  });

  it('starts a sync review when the completed run has no resumable snapshot', async () => {
    mockFindFirstRun.mockResolvedValue({
      id: 100,
      taskId: 'task-100',
      status: RunStatus.Completed,
      sandboxServerUrl: null,
      snapshotId: null,
      snapshotCreatedAt: null,
      port: null,
      payload: { repo: 'owner/repo' },
      actingUserId: null,
    });

    await activePrReviewFollowUpJob(makeJob());

    expect(mockEnqueueTask).toHaveBeenCalledWith({
      existingTaskId: 'task-100',
      task: data.fallback.task,
      initiator: {
        kind: 'automation',
        key: 'review_code',
        actor: data.fallback.initiatorActor,
      },
      workflow: 'pr_review',
      surface: 'github',
      trigger: 'webhook',
      prLinkage: data.fallback.prLinkage,
    });
    expect(mockUpdateWhere).toHaveBeenCalledOnce();
    expect(mockTransferGithubPrReviewCheckToRun).toHaveBeenCalledWith({
      installationId: 1,
      repository: 'owner/repo',
      prNumber: 42,
      taskId: 'task-100',
      previousRunId: 100,
      newRunId: 200,
      signal: mockReleaseGithubPrReviewLifecycleLock.signal,
    });
  });

  it('retries when fallback ownership cannot acquire the lifecycle lock', async () => {
    mockFindFirstRun.mockResolvedValue({
      id: 100,
      taskId: 'task-100',
      status: RunStatus.Completed,
      sandboxServerUrl: null,
      snapshotId: null,
      snapshotCreatedAt: null,
      port: null,
      payload: { repo: 'owner/repo' },
      actingUserId: null,
    });
    mockAcquireGithubPrReviewLifecycleLock.mockResolvedValueOnce(null);

    await expect(activePrReviewFollowUpJob(makeJob())).rejects.toThrow(
      'Timed out serializing PR review fallback for owner/repo#42',
    );

    expect(mockEnqueueTask).not.toHaveBeenCalled();
    expect(mockTransferGithubPrReviewCheckToRun).not.toHaveBeenCalled();
  });
});
