import { z } from 'zod';

const {
  mockBuildPrompt,
  mockEnqueueTask,
  mockFindFirstRun,
  mockFindFallbackRun,
  mockFindFirstRepository,
  mockGetTaskGoalForRun,
  mockSendPrompt,
  mockUpdateWhere,
  mockWithSandboxServerRpcClient,
  mockAcquireGithubPrReviewLifecycleLock,
  mockReleaseGithubPrReviewLifecycleLock,
  mockTransferGithubPrReviewCheckToRun,
  MockSnapshotResumeAlreadyExistsError,
} = vi.hoisted(() => ({
  mockBuildPrompt: vi.fn(),
  mockEnqueueTask: vi.fn(),
  mockFindFirstRun: vi.fn(),
  mockFindFallbackRun: vi.fn(),
  mockFindFirstRepository: vi.fn(),
  mockGetTaskGoalForRun: vi.fn(),
  mockSendPrompt: vi.fn(),
  mockUpdateWhere: vi.fn(),
  mockWithSandboxServerRpcClient: vi.fn(),
  mockAcquireGithubPrReviewLifecycleLock: vi.fn(),
  mockReleaseGithubPrReviewLifecycleLock: Object.assign(vi.fn(), {
    signal: new AbortController().signal,
  }),
  mockTransferGithubPrReviewCheckToRun: vi.fn(),
  MockSnapshotResumeAlreadyExistsError: class extends Error {
    constructor(public readonly existingRunId: number) {
      super(`Snapshot resume run ${existingRunId} already exists.`);
    }
  },
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  buildGitHubPrSynchronizeFollowUpMessage: (...args: unknown[]) =>
    mockBuildPrompt(...args),
  enqueueTask: (...args: unknown[]) => mockEnqueueTask(...args),
  SnapshotResumeAlreadyExistsError: MockSnapshotResumeAlreadyExistsError,
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: {
        findFirst: (input: { columns?: Record<string, boolean> }) =>
          input.columns && Object.keys(input.columns).length === 1
            ? mockFindFallbackRun(input)
            : mockFindFirstRun(input),
      },
      repositories: {
        findFirst: (...args: unknown[]) => mockFindFirstRepository(...args),
      },
    },
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: (...args: unknown[]) => mockUpdateWhere(...args),
      })),
    })),
  },
  eq: vi.fn((...args: unknown[]) => args),
  and: vi.fn((...args: unknown[]) => args),
  sql: vi.fn((...args: unknown[]) => args),
  getTaskGoalForRun: (...args: unknown[]) => mockGetTaskGoalForRun(...args),
  repositories: { id: 'repositories.id' },
  taskPullRequests: { taskId: 'taskPullRequests.taskId' },
  taskRuns: {
    id: 'taskRuns.id',
    taskId: 'taskRuns.taskId',
    payload: 'taskRuns.payload',
  },
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
      repositoryId: 'repo-id',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      prSha: 'new-head',
    },
  },
};

function makeJob(overrides: Partial<typeof data> = {}) {
  return {
    data: { ...data, ...overrides },
  } as unknown as Job<typeof data, void, string>;
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
    mockFindFallbackRun.mockResolvedValue(null);
    mockFindFirstRepository.mockResolvedValue({
      id: 'repo-id',
      githubInstallation: { installationId: 1 },
    });
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
      task: {
        ...data.fallback.task,
        payload: {
          ...data.fallback.task.payload,
          launchIdempotencyKey:
            'github-pr-review-fallback:task-100:100:new-head',
        },
      },
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

  it.each([
    ['no snapshot', null],
    ['snapshot resume', 'snapshot-100'],
  ])(
    'reuses fallback B after transfer fails once (%s)',
    async (_label, snapshotId) => {
      mockFindFirstRun.mockResolvedValue({
        id: 100,
        taskId: 'task-100',
        status: RunStatus.Completed,
        sandboxServerUrl: null,
        snapshotId,
        snapshotCreatedAt: snapshotId ? new Date() : null,
        port: snapshotId ? 3000 : null,
        payload: { repo: 'owner/repo' },
        actingUserId: 'user-1',
      });
      mockFindFallbackRun
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 200 });
      mockTransferGithubPrReviewCheckToRun
        .mockRejectedValueOnce(new Error('transfer failed'))
        .mockResolvedValueOnce(undefined);

      await expect(activePrReviewFollowUpJob(makeJob())).rejects.toThrow(
        'transfer failed',
      );
      await activePrReviewFollowUpJob(makeJob());

      expect(mockEnqueueTask).toHaveBeenCalledOnce();
      expect(mockTransferGithubPrReviewCheckToRun).toHaveBeenCalledTimes(2);
      expect(mockTransferGithubPrReviewCheckToRun).toHaveBeenLastCalledWith(
        expect.objectContaining({ newRunId: 200 }),
      );
      expect(mockUpdateWhere).toHaveBeenCalledOnce();
    },
  );

  it('reuses fallback B when linked-head persistence fails after transfer', async () => {
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
    mockFindFallbackRun
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 200 });
    mockUpdateWhere
      .mockRejectedValueOnce(new Error('head update failed'))
      .mockResolvedValueOnce(undefined);

    await expect(activePrReviewFollowUpJob(makeJob())).rejects.toThrow(
      'head update failed',
    );
    await activePrReviewFollowUpJob(makeJob());

    expect(mockEnqueueTask).toHaveBeenCalledOnce();
    expect(mockTransferGithubPrReviewCheckToRun).toHaveBeenCalledTimes(2);
    expect(mockUpdateWhere).toHaveBeenCalledTimes(2);
  });

  it('recovers the existing SnapshotResume run when enqueue reports a duplicate', async () => {
    mockFindFirstRun.mockResolvedValue({
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
    mockEnqueueTask.mockRejectedValueOnce(
      new MockSnapshotResumeAlreadyExistsError(200),
    );

    await activePrReviewFollowUpJob(makeJob());

    expect(mockTransferGithubPrReviewCheckToRun).toHaveBeenCalledWith(
      expect.objectContaining({ newRunId: 200 }),
    );
  });

  it('resolves installation context for legacy jobs before launching fallback B', async () => {
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

    await activePrReviewFollowUpJob(
      makeJob({ installationId: undefined as never }),
    );

    expect(mockFindFirstRepository).toHaveBeenCalledOnce();
    expect(mockTransferGithubPrReviewCheckToRun).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: 1, newRunId: 200 }),
    );
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
