import { z } from 'zod';

const {
  mockBuildPrompt,
  mockEnqueueTask,
  mockFindFirstRun,
  mockGetTaskGoalForRun,
  mockSendPrompt,
  mockUpdateWhere,
  mockWithSandboxServerRpcClient,
} = vi.hoisted(() => ({
  mockBuildPrompt: vi.fn(),
  mockEnqueueTask: vi.fn(),
  mockFindFirstRun: vi.fn(),
  mockGetTaskGoalForRun: vi.fn(),
  mockSendPrompt: vi.fn(),
  mockUpdateWhere: vi.fn(),
  mockWithSandboxServerRpcClient: vi.fn(),
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
    runId: z.number(),
    taskId: z.string(),
    sandboxServerUrl: z.string(),
    repository: z.string(),
    prNumber: z.number(),
    previousHeadSha: z.string().nullable(),
    eventHeadSha: z.string(),
    fallback: z.any(),
  }),
  withSandboxServerRpcClient: (...args: unknown[]) =>
    mockWithSandboxServerRpcClient(...args),
}));

import type { Job } from 'bullmq';

import { RunStatus, TaskPayloadKind } from '@roomote/types';

import { activePrReviewFollowUpJob } from './active-pr-review-follow-up';

const data = {
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
    expect(mockUpdateWhere).not.toHaveBeenCalled();
  });
});
