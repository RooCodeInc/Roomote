import { RunStatus, TaskPayloadKind } from '@roomote/types';
import type { TaskRun } from '@roomote/db/server';

const {
  mockDbTransaction,
  mockTxFindFirstBackgroundAgentSettings,
  mockEq,
  mockSql,
  mockTxExecute,
  mockTxFindFirstTaskRuns,
  mockTxUpdate,
  mockTxUpdateSet,
  mockTxUpdateWhere,
  mockReleaseTaskRun,
  mockGeneratePrompt,
  mockFetchEnvVars,
  mockFetchResolvedRuntimeEnvVars,
  mockClaimJobById,
  mockCancelAndReleaseTaskRun,
  mockNotifyCanceledTaskRunOnSettle,
  mockCreateSourceControlTokenForTaskRun,
  mockCancelTaskRun,
  mockReportBootstrapFailure,
  mockResolveGitAuthor,
  mockRecordTaskRunLifecycleEvent,
  mockGetRedis,
  mockResolveSlackTaskRunRouting,
  mockResolveTaskRunSourceControlProviders,
  mockMarkGithubPrReviewCheckInProgress,
  onBootstrapFailureMock,
} = vi.hoisted(() => ({
  mockDbTransaction: vi.fn(),
  mockTxFindFirstBackgroundAgentSettings: vi.fn(),
  mockEq: vi.fn(),
  mockSql: vi.fn(),
  mockTxExecute: vi.fn(),
  mockTxFindFirstTaskRuns: vi.fn(),
  mockTxUpdateWhere: vi.fn(),
  mockTxUpdateSet: vi.fn(),
  mockTxUpdate: vi.fn(),
  mockReleaseTaskRun: vi.fn(),
  mockGeneratePrompt: vi.fn(),
  mockFetchEnvVars: vi.fn(),
  mockFetchResolvedRuntimeEnvVars: vi.fn(),
  mockClaimJobById: vi.fn(),
  mockCancelAndReleaseTaskRun: vi.fn(),
  mockNotifyCanceledTaskRunOnSettle: vi.fn(),
  mockCreateSourceControlTokenForTaskRun: vi.fn(),
  mockCancelTaskRun: vi.fn(),
  mockReportBootstrapFailure: vi.fn(),
  mockResolveGitAuthor: vi.fn(),
  mockRecordTaskRunLifecycleEvent: vi.fn(),
  mockGetRedis: vi.fn(() => 'redis-client'),
  mockResolveSlackTaskRunRouting: vi.fn(),
  mockResolveTaskRunSourceControlProviders: vi.fn(),
  mockMarkGithubPrReviewCheckInProgress: vi.fn(),
  onBootstrapFailureMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    transaction: (...args: unknown[]) => mockDbTransaction(...args),
    update: (...args: unknown[]) => mockTxUpdate(...args),
  },
  deploymentSettings: { orgId: 'deploymentSettings.orgId' },
  taskRuns: { id: 'taskRuns.id', taskId: 'taskRuns.taskId' },
  tasks: { id: 'tasks.id' },
  taskPullRequests: { taskId: 'taskPullRequests.taskId' },
  and: (...args: unknown[]) => args,
  eq: (...args: unknown[]) => mockEq(...args),
  recordTaskRunLifecycleEvent: (...args: unknown[]) =>
    mockRecordTaskRunLifecycleEvent(...args),
  sql: (...args: unknown[]) => mockSql(...args),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  releaseTaskRun: (...args: unknown[]) => mockReleaseTaskRun(...args),
  generatePrompt: (...args: unknown[]) => mockGeneratePrompt(...args),
  getTaskUrl: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => mockGetRedis(),
}));

vi.mock('../slack-task-run-routing', () => ({
  resolveSlackTaskRunRouting: (...args: unknown[]) =>
    mockResolveSlackTaskRunRouting(...args),
}));

vi.mock('../dequeue-helpers', () => ({
  fetchEnvVars: (...args: unknown[]) => mockFetchEnvVars(...args),
  fetchResolvedRuntimeEnvVars: (...args: unknown[]) =>
    mockFetchResolvedRuntimeEnvVars(...args),
  claimJobById: (...args: unknown[]) => mockClaimJobById(...args),
  cancelAndReleaseTaskRun: (...args: unknown[]) =>
    mockCancelAndReleaseTaskRun(...args),
  notifyCanceledTaskRunOnSettle: (...args: unknown[]) =>
    mockNotifyCanceledTaskRunOnSettle(...args),
  createSourceControlTokenForTaskRun: (...args: unknown[]) =>
    mockCreateSourceControlTokenForTaskRun(...args),
  cancelTaskRun: (...args: unknown[]) => mockCancelTaskRun(...args),
  reportBootstrapFailure: (...args: unknown[]) =>
    mockReportBootstrapFailure(...args),
  resolveGitAuthor: (...args: unknown[]) => mockResolveGitAuthor(...args),
  resolveTaskRunSourceControlProviders: (...args: unknown[]) =>
    mockResolveTaskRunSourceControlProviders(...args),
}));

vi.mock('../github-pr-review-check', () => ({
  markGithubPrReviewCheckInProgress: (...args: unknown[]) =>
    mockMarkGithubPrReviewCheckInProgress(...args),
}));

import { dequeueTaskRun } from '../dequeue-task-run';

type RunWithTask = TaskRun & { task: Record<string, unknown> };

function makeTaskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-101',
    workflow: 'standard',
    surface: 'web',
    trigger: 'manual',
    title: 'Task 101',
    prompt: null,
    harnessInstructions: null,
    requestedWorkKind: 'unknown',
    slackChannelId: null,
    slackThreadTs: null,
    linearSessionId: null,
    linearIssueId: null,
    linearOrganizationId: null,
    ...overrides,
  };
}

function makeStandardTaskRun(
  overrides: Partial<RunWithTask> = {},
): RunWithTask {
  return {
    id: 101,
    harness: 'opencode-server',
    status: RunStatus.Dequeued,
    kind: 'fresh',
    payloadKind: TaskPayloadKind.StandardTask,
    taskId: 'task-101',
    actingUserId: 'user-1',
    sourceRunId: null,
    sourceSnapshotId: null,
    payload: {
      repo: 'owner/repo',
      description: 'Investigate auth flakes',
    },
    result: null,
    task: makeTaskRow(),
    ...overrides,
  } as RunWithTask;
}

function makeSlackAppMentionRun(
  overrides: Partial<RunWithTask> = {},
): RunWithTask {
  return {
    id: 202,
    harness: 'opencode-server',
    status: RunStatus.Dequeued,
    kind: 'fresh',
    payloadKind: TaskPayloadKind.SlackAppMention,
    taskId: 'task-202',
    actingUserId: 'user-1',
    sourceRunId: null,
    sourceSnapshotId: null,
    task: makeTaskRow({ id: 'task-202', surface: 'slack' }),
    payload: {
      repo: 'owner/repo',
      description: 'Reply in Slack',
      channel: 'C123',
      user: 'U123',
      text: 'help',
      ts: '1710000000.000100',
    },
    result: null,
    ...overrides,
  } as RunWithTask;
}

function makeLinearAgentSessionRun(
  overrides: Partial<RunWithTask> = {},
): RunWithTask {
  return {
    id: 303,
    harness: 'opencode-server',
    status: RunStatus.Dequeued,
    kind: 'fresh',
    payloadKind: TaskPayloadKind.LinearAgentSession,
    taskId: 'task-303',
    actingUserId: 'user-1',
    sourceRunId: null,
    sourceSnapshotId: null,
    task: makeTaskRow({
      id: 'task-303',
      surface: 'linear',
      linearSessionId: 'linear-session-1',
      linearIssueId: 'linear-issue-1',
      linearOrganizationId: 'linear-organization-1',
    }),
    payload: {
      repo: 'owner/repo',
      sessionId: 'linear-session-1',
      organizationId: 'linear-organization-1',
      action: 'created',
      issueId: 'linear-issue-1',
      issueIdentifier: 'ROO-37',
      issueTitle: 'Change the background to red',
      issueUrl: 'https://linear.app/acme/issue/ROO-37',
    },
    result: null,
    ...overrides,
  } as RunWithTask;
}

describe('dequeueTaskRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockEq.mockReturnValue('eq-clause');
    mockSql.mockReturnValue('claim-query');
    mockClaimJobById.mockReturnValue('claim-query');
    mockFetchEnvVars.mockResolvedValue({ ORG_ENV: '1' });
    mockResolveTaskRunSourceControlProviders.mockResolvedValue(['github']);
    mockResolveGitAuthor.mockResolvedValue({
      name: 'Roomote',
      email: 'roomote@example.com',
    });
    mockCreateSourceControlTokenForTaskRun.mockResolvedValue({
      provider: 'github',
      token: 'gh-token',
      envVar: 'GH_TOKEN',
      envVars: { GH_TOKEN: 'gh-token' },
      source: 'app',
      expiresAt: null,
    });
    mockFetchResolvedRuntimeEnvVars.mockResolvedValue({ RESOLVED_ENV: '1' });
    mockCancelTaskRun.mockResolvedValue(undefined);
    mockCancelAndReleaseTaskRun.mockResolvedValue(undefined);
    mockReleaseTaskRun.mockResolvedValue(true);
    mockTxFindFirstBackgroundAgentSettings.mockResolvedValue(undefined);
    mockReportBootstrapFailure.mockImplementation(
      ({
        callback,
        error,
        taskRun,
      }: {
        callback?: (error: Error, taskRun: TaskRun) => void;
        error: Error;
        taskRun: TaskRun;
      }) => callback?.(error, taskRun),
    );
    mockGeneratePrompt.mockResolvedValue({
      prompt: 'prompt',
      harnessInstructions: 'instructions',
      artifacts: {},
    });
    mockResolveSlackTaskRunRouting.mockResolvedValue({
      channel: null,
      threadTs: null,
      route: { kind: 'task', webPath: null },
    });

    mockTxUpdateWhere.mockResolvedValue(undefined);
    mockTxUpdateSet.mockImplementation((values: unknown) => {
      if (values != null && typeof values === 'object') {
        const entries = Object.entries(values as Record<string, unknown>);

        if (
          entries.length === 0 ||
          entries.every(([, value]) => value === undefined)
        ) {
          throw new Error('No values to set');
        }
      }

      return {
        where: (...args: unknown[]) => mockTxUpdateWhere(...args),
      };
    });
    mockTxUpdate.mockImplementation((..._args: unknown[]) => ({
      set: (...args: unknown[]) => mockTxUpdateSet(...args),
    }));

    mockDbTransaction.mockImplementation(async (callback: unknown) => {
      if (typeof callback !== 'function') {
        throw new Error('Expected transaction callback');
      }

      return callback({
        execute: (...args: unknown[]) => mockTxExecute(...args),
        query: {
          deploymentSettings: {
            findFirst: (...args: unknown[]) =>
              mockTxFindFirstBackgroundAgentSettings(...args),
          },
          taskRuns: {
            findFirst: (...args: unknown[]) => mockTxFindFirstTaskRuns(...args),
          },
        },
        update: (...args: unknown[]) => mockTxUpdate(...args),
      });
    });
  });

  it('treats StandardTask jobs without identity metadata as runnable', async () => {
    const taskRun = makeStandardTaskRun();

    mockResolveTaskRunSourceControlProviders.mockResolvedValue([
      'gitlab',
      'github',
    ]);
    mockCreateSourceControlTokenForTaskRun.mockResolvedValue({
      provider: 'gitlab',
      token: 'gl-token',
      envVar: 'GITLAB_TOKEN',
      envVars: { GH_TOKEN: 'gh-token' },
      source: 'app',
      expiresAt: null,
    });
    mockTxExecute.mockResolvedValue([{ id: taskRun.id }]);
    mockTxFindFirstTaskRuns.mockResolvedValue(taskRun);

    const result = await dequeueTaskRun({ orgId: 'org-1' } as never, {
      runId: taskRun.id,
    });
    expect(mockGeneratePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        taskRun,
        taskSpec: expect.objectContaining({
          type: TaskPayloadKind.StandardTask,
        }),
        gitHubToken: 'gh-token',
      }),
    );
    expect(result?.prompt).toBe('prompt');
    expect(result?.harnessInstructions).toBe('instructions');
    expect(result?.requestedWorkKind).toBe('unknown');
    expect(mockFetchEnvVars).toHaveBeenCalledWith(expect.anything(), {
      sourceControlProvider: ['gitlab', 'github'],
    });
    expect(mockFetchResolvedRuntimeEnvVars).toHaveBeenCalledWith(
      { ORG_ENV: '1' },
      {
        sourceControlProvider: ['gitlab', 'github'],
        includeSandboxOpenRouterApiKey: false,
      },
    );
    expect(result?.task).toMatchObject({
      id: 'task-101',
      title: 'Task 101',
      slackChannelId: null,
      slackThreadTs: null,
      linearSessionId: null,
    });
    // Per-attempt prompt/artifacts persist on the run; generated harness
    // instructions persist on the task.
    expect(mockTxUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'prompt',
        artifacts: {},
      }),
    );
    expect(mockTxUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        harnessInstructions: 'instructions',
        updatedAt: expect.any(Date),
      }),
    );
  });

  it('persists worker runtime metadata when the worker claims the run', async () => {
    const taskRun = makeStandardTaskRun();

    mockTxExecute.mockResolvedValue([{ id: taskRun.id }]);
    mockTxFindFirstTaskRuns.mockResolvedValue(taskRun);

    await dequeueTaskRun({ orgId: 'org-1' } as never, {
      runId: taskRun.id,
      workerReleaseTag: 'worker-v1.2.3',
      workerVersion: '1.2.3',
      workerCommit: 'abc123',
    });

    expect(mockTxUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        startedAt: expect.any(Date),
        workerReleaseTag: 'worker-v1.2.3',
        workerVersion: '1.2.3',
        workerCommit: 'abc123',
      }),
    );
    expect(mockRecordTaskRunLifecycleEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({
          workerReleaseTag: 'worker-v1.2.3',
          workerVersion: '1.2.3',
          workerCommit: 'abc123',
        }),
      }),
    );
  });

  it('returns org-wide agent instructions when configured', async () => {
    const taskRun = makeStandardTaskRun();

    mockTxExecute.mockResolvedValue([{ id: taskRun.id }]);
    mockTxFindFirstTaskRuns.mockResolvedValue(taskRun);
    mockTxFindFirstBackgroundAgentSettings.mockResolvedValue({
      globalAgentInstructions: 'Prefer concise summaries.',
    });

    const result = await dequeueTaskRun({ orgId: 'org-1' } as never, {
      runId: taskRun.id,
    });

    expect(result?.orgAgentInstructions).toBe('Prefer concise summaries.');
  });

  it('marks Slack setup onboarding jobs from the routing contract', async () => {
    const taskRun = makeSlackAppMentionRun({
      payload: {
        repo: 'owner/repo',
        description: 'Reply in Slack',
        channel: 'C123',
        user: 'U123',
        text: 'help',
        ts: '1710000000.000100',
        webPath: '/setup',
      },
    });

    mockTxExecute.mockResolvedValue([{ id: taskRun.id }]);
    mockTxFindFirstTaskRuns.mockResolvedValue(taskRun);
    mockResolveSlackTaskRunRouting.mockResolvedValue({
      channel: 'C123',
      threadTs: '1710000000.000100',
      route: { kind: 'setup-onboarding', webPath: '/setup' },
    });

    const result = await dequeueTaskRun({ orgId: 'org-1' } as never, {
      runId: taskRun.id,
    });

    expect(result?.setupOnboardingTask).toBe(true);
    expect(mockResolveSlackTaskRunRouting).toHaveBeenCalledWith(taskRun);
  });
  it('stamps startedAt before prompt generation begins', async () => {
    const taskRun = makeStandardTaskRun();

    mockTxExecute.mockResolvedValue([{ id: taskRun.id }]);
    mockTxFindFirstTaskRuns.mockResolvedValue(taskRun);

    await dequeueTaskRun({ orgId: 'org-1' } as never, {
      runId: taskRun.id,
    });

    const startedAtCallIndex = mockTxUpdateSet.mock.calls.findIndex(
      ([values]) =>
        values != null &&
        typeof values === 'object' &&
        'startedAt' in (values as Record<string, unknown>),
    );

    expect(startedAtCallIndex).toBeGreaterThanOrEqual(0);

    const startedAtCallOrder =
      mockTxUpdateSet.mock.invocationCallOrder[startedAtCallIndex];
    const promptCallOrder = mockGeneratePrompt.mock.invocationCallOrder[0];

    expect(promptCallOrder).toBeDefined();
    expect(startedAtCallOrder).toBeLessThan(promptCallOrder ?? 0);
  });

  it('records a worker_bootstrap lifecycle event after the worker claims the run', async () => {
    const taskRun = makeStandardTaskRun({
      vendor: 'modal',
      machineId: 'sb_123',
      sourceSnapshotId: 'snap_env_123',
      payload: {
        repo: 'owner/repo',
        description: 'Investigate auth flakes',
        environmentId: '11111111-1111-4111-8111-111111111111',
      },
    });

    mockTxExecute.mockResolvedValue([{ id: taskRun.id }]);
    mockTxFindFirstTaskRuns.mockResolvedValue(taskRun);

    await dequeueTaskRun({ orgId: 'org-1' } as never, {
      runId: taskRun.id,
    });

    expect(mockFetchResolvedRuntimeEnvVars).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ includeSandboxOpenRouterApiKey: true }),
    );

    expect(mockRecordTaskRunLifecycleEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: taskRun.id,
        taskId: taskRun.taskId,
        eventType: 'started',
        message: expect.stringContaining('started execution bootstrap'),
        details: expect.objectContaining({
          stage: 'worker_bootstrap',
          status: RunStatus.Processing,
          vendor: 'modal',
          machineId: 'sb_123',
          sourceSnapshotId: 'snap_env_123',
          environmentId: '11111111-1111-4111-8111-111111111111',
          payloadKind: TaskPayloadKind.StandardTask,
        }),
      }),
    );
  });

  it('records bootstrap phase events for token, prompt, env resolution, and routing', async () => {
    const taskRun = makeStandardTaskRun();

    mockTxExecute.mockResolvedValue([{ id: taskRun.id }]);
    mockTxFindFirstTaskRuns.mockResolvedValue(taskRun);

    await dequeueTaskRun({ orgId: 'org-1' } as never, {
      runId: taskRun.id,
    });

    expect(mockRecordTaskRunLifecycleEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: taskRun.id,
        taskId: taskRun.taskId,
        eventType: 'phase',
        message: 'createSourceControlToken',
        details: expect.objectContaining({
          phase: 'createSourceControlToken',
          outcome: 'ok',
          durationMs: expect.any(Number),
          payloadKind: TaskPayloadKind.StandardTask,
          provider: 'github',
        }),
      }),
    );
    expect(mockRecordTaskRunLifecycleEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'phase',
        message: 'generatePrompt',
        details: expect.objectContaining({
          phase: 'generatePrompt',
          outcome: 'ok',
          durationMs: expect.any(Number),
        }),
      }),
    );
    expect(mockRecordTaskRunLifecycleEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'phase',
        message: 'resolveRuntimeEnvVars',
        details: expect.objectContaining({
          phase: 'resolveRuntimeEnvVars',
          outcome: 'ok',
          durationMs: expect.any(Number),
        }),
      }),
    );
    expect(mockRecordTaskRunLifecycleEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'phase',
        message: 'resolveLaunchFlagsAndRouting',
        details: expect.objectContaining({
          phase: 'resolveLaunchFlagsAndRouting',
          outcome: 'ok',
          durationMs: expect.any(Number),
        }),
      }),
    );
  });

  it('records createSourceControlToken as failed when token creation returns null', async () => {
    const taskRun = makeStandardTaskRun();

    mockTxExecute.mockResolvedValue([{ id: taskRun.id }]);
    mockTxFindFirstTaskRuns.mockResolvedValue(taskRun);
    mockCreateSourceControlTokenForTaskRun.mockResolvedValueOnce(null);

    const result = await dequeueTaskRun({ orgId: 'org-1' } as never, {
      runId: taskRun.id,
    });

    expect(result).toBeUndefined();
    expect(mockRecordTaskRunLifecycleEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: taskRun.id,
        taskId: taskRun.taskId,
        eventType: 'phase',
        message: 'createSourceControlToken',
        details: expect.objectContaining({
          phase: 'createSourceControlToken',
          outcome: 'failed',
          durationMs: expect.any(Number),
          error: expect.stringContaining('returned no token'),
          payloadKind: TaskPayloadKind.StandardTask,
          provider: 'github',
        }),
      }),
    );
    expect(mockCancelAndReleaseTaskRun).toHaveBeenCalledWith(
      taskRun,
      'Failed to create source control token.',
      expect.any(String),
    );
  });

  it('skips slackThreadTs persistence when the job is not Slack-originated', async () => {
    const taskRun = makeStandardTaskRun();

    mockTxExecute.mockResolvedValue([{ id: taskRun.id }]);
    mockTxFindFirstTaskRuns.mockResolvedValue(taskRun);

    const result = await dequeueTaskRun({ orgId: 'org-1' } as never, {
      runId: taskRun.id,
    });

    expect(result?.taskRun.id).toBe(taskRun.id);
    expect(
      mockTxUpdateSet.mock.calls.some(
        ([values]) =>
          values != null &&
          typeof values === 'object' &&
          'slackThreadTs' in (values as Record<string, unknown>),
      ),
    ).toBe(false);
  });

  it('skips slackThreadTs persistence when a Slack mention has no thread_ts', async () => {
    const taskRun = makeSlackAppMentionRun();

    mockTxExecute.mockResolvedValue([{ id: taskRun.id }]);
    mockTxFindFirstTaskRuns.mockResolvedValue(taskRun);

    const result = await dequeueTaskRun({ orgId: 'org-1' } as never, {
      runId: taskRun.id,
    });

    expect(result?.taskRun.id).toBe(taskRun.id);
    expect(
      mockTxUpdateSet.mock.calls.some(
        ([values]) =>
          values != null &&
          typeof values === 'object' &&
          'slackThreadTs' in (values as Record<string, unknown>),
      ),
    ).toBe(false);
  });

  it('keeps standard jobs runnable during dequeue', async () => {
    const taskRun = makeStandardTaskRun();

    mockTxExecute.mockResolvedValue([{ id: taskRun.id }]);
    mockTxFindFirstTaskRuns.mockResolvedValue(taskRun);

    await dequeueTaskRun({ orgId: 'org-1' } as never, {
      runId: taskRun.id,
    });

    expect(mockGeneratePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        taskRun,
        taskSpec: expect.objectContaining({
          type: TaskPayloadKind.StandardTask,
        }),
      }),
    );
    expect(mockCancelTaskRun).not.toHaveBeenCalledWith(
      expect.anything(),
      taskRun.id,
      'Task run is not valid.',
    );
  });

  it('keeps Linear agent session jobs runnable during dequeue', async () => {
    const taskRun = makeLinearAgentSessionRun();

    mockTxExecute.mockResolvedValue([{ id: taskRun.id }]);
    mockTxFindFirstTaskRuns.mockResolvedValue(taskRun);

    await dequeueTaskRun({ orgId: 'org-1' } as never, {
      runId: taskRun.id,
    });

    expect(mockGeneratePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        taskSpec: expect.objectContaining({
          type: TaskPayloadKind.LinearAgentSession,
          linearSessionId: 'linear-session-1',
          linearIssueId: 'linear-issue-1',
          linearOrganizationId: 'linear-organization-1',
        }),
      }),
    );
    expect(mockCancelTaskRun).not.toHaveBeenCalledWith(
      expect.anything(),
      taskRun.id,
      'Task run is not valid.',
    );
  });

  it('invokes the bootstrap failure callback before canceling an invalid run', async () => {
    const taskRun = makeStandardTaskRun({
      payloadKind: TaskPayloadKind.GithubPrReview,
      payload: {
        repo: 'owner/repo',
        prNumber: '42' as never,
        prTitle: 'Fix it',
        prUrl: 'https://github.com/owner/repo/pull/42',
        headSha: '1234567890abcdef1234567890abcdef12345678',
      },
    });

    mockTxExecute.mockResolvedValue([{ id: taskRun.id }]);
    mockTxFindFirstTaskRuns.mockResolvedValue(taskRun);
    const result = await dequeueTaskRun(
      { orgId: 'org-1' } as never,
      {
        runId: taskRun.id,
      },
      {
        onBootstrapFailure: onBootstrapFailureMock,
      },
    );

    expect(result).toBeUndefined();
    expect(onBootstrapFailureMock).toHaveBeenCalledTimes(1);
    expect(onBootstrapFailureMock).toHaveBeenCalledWith(
      expect.any(Error),
      taskRun,
    );
    expect(mockCancelTaskRun).toHaveBeenCalledWith(
      expect.anything(),
      taskRun.id,
      'Task run is not valid.',
      expect.objectContaining({
        bootstrapFailureReason: 'schema_validation_failed',
        existingArtifacts: taskRun.artifacts,
      }),
    );
    expect(mockNotifyCanceledTaskRunOnSettle).toHaveBeenCalledWith(taskRun);
  });

  it('starts only the check owned by the dequeued PR review run', async () => {
    const taskRun = makeStandardTaskRun({
      payloadKind: TaskPayloadKind.GithubPrReview,
      task: makeTaskRow({ workflow: 'pr_review', surface: 'github' }),
      payload: {
        repo: 'owner/repo',
        prNumber: 42,
        prTitle: 'Fix it',
        prUrl: 'https://github.com/owner/repo/pull/42',
        headSha: '1234567890abcdef1234567890abcdef12345678',
      },
    });
    mockTxExecute.mockResolvedValue([{ id: taskRun.id }]);
    mockTxFindFirstTaskRuns.mockResolvedValue(taskRun);

    await dequeueTaskRun({ orgId: 'org-1' } as never, {
      runId: taskRun.id,
    });

    expect(mockMarkGithubPrReviewCheckInProgress).toHaveBeenCalledWith({
      taskId: taskRun.taskId,
      runId: taskRun.id,
      gitHubToken: 'gh-token',
    });
  });

  it('cancels the task run when launch metadata persistence fails for PR review runs', async () => {
    const taskRun = makeStandardTaskRun({
      payloadKind: TaskPayloadKind.GithubPrReview,
      payload: {
        repo: 'owner/repo',
        prNumber: 42,
        prTitle: 'Fix it',
        prUrl: 'https://github.com/owner/repo/pull/42',
        headSha: '1234567890abcdef1234567890abcdef12345678',
      },
    });

    mockTxExecute.mockResolvedValue([{ id: taskRun.id }]);
    mockTxFindFirstTaskRuns.mockResolvedValue(taskRun);
    mockTxUpdateWhere
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('write failed'));

    const result = await dequeueTaskRun({ orgId: 'org-1' } as never, {
      runId: taskRun.id,
    });

    expect(result).toBeUndefined();
    expect(mockCancelAndReleaseTaskRun).toHaveBeenCalledWith(
      taskRun,
      expect.stringContaining('Failed to persist launch metadata'),
      '[dequeueTaskRun]',
    );
  });
});
