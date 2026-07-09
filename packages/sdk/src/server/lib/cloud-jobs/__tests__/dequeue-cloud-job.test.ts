import { CloudTaskStatus, TaskPayloadKind } from '@roomote/types';
import type { CloudJob } from '@roomote/db/server';

const {
  mockDbTransaction,
  mockTxFindFirstBackgroundAgentSettings,
  mockEq,
  mockSql,
  mockTxExecute,
  mockTxFindFirstCloudJobs,
  mockTxUpdate,
  mockTxUpdateSet,
  mockTxUpdateWhere,
  mockReleaseCloudTask,
  mockGeneratePrompt,
  mockFetchEnvVars,
  mockFetchResolvedRuntimeEnvVars,
  mockClaimJobById,
  mockCancelAndReleaseCloudJob,
  mockCreateSourceControlTokenForJob,
  mockCancelCloudJob,
  mockReportBootstrapFailure,
  mockResolveGitAuthor,
  mockRecordJobLifecycleEvent,
  mockGetRedis,
  mockResolveSlackJobRouting,
  onBootstrapFailureMock,
} = vi.hoisted(() => ({
  mockDbTransaction: vi.fn(),
  mockTxFindFirstBackgroundAgentSettings: vi.fn(),
  mockEq: vi.fn(),
  mockSql: vi.fn(),
  mockTxExecute: vi.fn(),
  mockTxFindFirstCloudJobs: vi.fn(),
  mockTxUpdateWhere: vi.fn(),
  mockTxUpdateSet: vi.fn(),
  mockTxUpdate: vi.fn(),
  mockReleaseCloudTask: vi.fn(),
  mockGeneratePrompt: vi.fn(),
  mockFetchEnvVars: vi.fn(),
  mockFetchResolvedRuntimeEnvVars: vi.fn(),
  mockClaimJobById: vi.fn(),
  mockCancelAndReleaseCloudJob: vi.fn(),
  mockCreateSourceControlTokenForJob: vi.fn(),
  mockCancelCloudJob: vi.fn(),
  mockReportBootstrapFailure: vi.fn(),
  mockResolveGitAuthor: vi.fn(),
  mockRecordJobLifecycleEvent: vi.fn(),
  mockGetRedis: vi.fn(() => 'redis-client'),
  mockResolveSlackJobRouting: vi.fn(),
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
  recordJobLifecycleEvent: (...args: unknown[]) =>
    mockRecordJobLifecycleEvent(...args),
  sql: (...args: unknown[]) => mockSql(...args),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  releaseCloudTask: (...args: unknown[]) => mockReleaseCloudTask(...args),
  generatePrompt: (...args: unknown[]) => mockGeneratePrompt(...args),
  getTaskUrl: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => mockGetRedis(),
}));

vi.mock('../slack-job-routing', () => ({
  resolveSlackJobRouting: (...args: unknown[]) =>
    mockResolveSlackJobRouting(...args),
}));

vi.mock('../dequeue-helpers', () => ({
  fetchEnvVars: (...args: unknown[]) => mockFetchEnvVars(...args),
  fetchResolvedRuntimeEnvVars: (...args: unknown[]) =>
    mockFetchResolvedRuntimeEnvVars(...args),
  claimJobById: (...args: unknown[]) => mockClaimJobById(...args),
  cancelAndReleaseCloudJob: (...args: unknown[]) =>
    mockCancelAndReleaseCloudJob(...args),
  createSourceControlTokenForJob: (...args: unknown[]) =>
    mockCreateSourceControlTokenForJob(...args),
  cancelCloudJob: (...args: unknown[]) => mockCancelCloudJob(...args),
  reportBootstrapFailure: (...args: unknown[]) =>
    mockReportBootstrapFailure(...args),
  resolveGitAuthor: (...args: unknown[]) => mockResolveGitAuthor(...args),
}));

import { dequeueCloudJob } from '../dequeue-cloud-job';

type RunWithTask = CloudJob & { task: Record<string, unknown> };

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

function makeStandardTaskJob(
  overrides: Partial<RunWithTask> = {},
): RunWithTask {
  return {
    id: 101,
    harness: 'opencode-server',
    status: CloudTaskStatus.Dequeued,
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

function makeSlackAppMentionJob(
  overrides: Partial<RunWithTask> = {},
): RunWithTask {
  return {
    id: 202,
    harness: 'opencode-server',
    status: CloudTaskStatus.Dequeued,
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

describe('dequeueCloudJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockEq.mockReturnValue('eq-clause');
    mockSql.mockReturnValue('claim-query');
    mockClaimJobById.mockReturnValue('claim-query');
    mockFetchEnvVars.mockResolvedValue({ ORG_ENV: '1' });
    mockResolveGitAuthor.mockResolvedValue({
      name: 'Roomote',
      email: 'roomote@example.com',
    });
    mockCreateSourceControlTokenForJob.mockResolvedValue({
      provider: 'github',
      token: 'gh-token',
      envVar: 'GH_TOKEN',
      envVars: { GH_TOKEN: 'gh-token' },
      source: 'app',
      expiresAt: null,
    });
    mockFetchResolvedRuntimeEnvVars.mockResolvedValue({ RESOLVED_ENV: '1' });
    mockCancelCloudJob.mockResolvedValue(undefined);
    mockCancelAndReleaseCloudJob.mockResolvedValue(undefined);
    mockReleaseCloudTask.mockResolvedValue(true);
    mockTxFindFirstBackgroundAgentSettings.mockResolvedValue(undefined);
    mockReportBootstrapFailure.mockImplementation(
      ({
        callback,
        error,
        cloudJob,
      }: {
        callback?: (error: Error, cloudJob: CloudJob) => void;
        error: Error;
        cloudJob: CloudJob;
      }) => callback?.(error, cloudJob),
    );
    mockGeneratePrompt.mockResolvedValue({
      prompt: 'prompt',
      harnessInstructions: 'instructions',
      artifacts: {},
    });
    mockResolveSlackJobRouting.mockResolvedValue({
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
            findFirst: (...args: unknown[]) =>
              mockTxFindFirstCloudJobs(...args),
          },
        },
        update: (...args: unknown[]) => mockTxUpdate(...args),
      });
    });
  });

  it('treats null-agent StandardTask jobs as implicit Generalist jobs', async () => {
    const cloudJob = makeStandardTaskJob();

    mockTxExecute.mockResolvedValue([{ id: cloudJob.id }]);
    mockTxFindFirstCloudJobs.mockResolvedValue(cloudJob);

    const result = await dequeueCloudJob({ orgId: 'org-1' } as never, {
      cloudJobId: cloudJob.id,
    });
    expect(mockGeneratePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudJob,
        cloudTask: expect.objectContaining({
          type: TaskPayloadKind.StandardTask,
        }),
        gitHubToken: 'gh-token',
      }),
    );
    expect(result?.prompt).toBe('prompt');
    expect(result?.harnessInstructions).toBe('instructions');
    expect(result?.requestedWorkKind).toBe('unknown');
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

  it('persists worker runtime metadata when the worker claims the job', async () => {
    const cloudJob = makeStandardTaskJob();

    mockTxExecute.mockResolvedValue([{ id: cloudJob.id }]);
    mockTxFindFirstCloudJobs.mockResolvedValue(cloudJob);

    await dequeueCloudJob({ orgId: 'org-1' } as never, {
      cloudJobId: cloudJob.id,
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
    expect(mockRecordJobLifecycleEvent).toHaveBeenCalledWith(
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
    const cloudJob = makeStandardTaskJob();

    mockTxExecute.mockResolvedValue([{ id: cloudJob.id }]);
    mockTxFindFirstCloudJobs.mockResolvedValue(cloudJob);
    mockTxFindFirstBackgroundAgentSettings.mockResolvedValue({
      globalAgentInstructions: 'Prefer concise summaries.',
    });

    const result = await dequeueCloudJob({ orgId: 'org-1' } as never, {
      cloudJobId: cloudJob.id,
    });

    expect(result?.orgAgentInstructions).toBe('Prefer concise summaries.');
  });

  it('returns style guidance when configured', async () => {
    const cloudJob = makeStandardTaskJob();

    mockTxExecute.mockResolvedValue([{ id: cloudJob.id }]);
    mockTxFindFirstCloudJobs.mockResolvedValue(cloudJob);
    mockTxFindFirstBackgroundAgentSettings.mockResolvedValue({
      globalAgentInstructions: 'Prefer concise summaries.',
      styleGuidance: 'Be direct and calm.',
    });

    const result = await dequeueCloudJob({ orgId: 'org-1' } as never, {
      cloudJobId: cloudJob.id,
    });

    expect(result?.styleGuidance).toBe('Be direct and calm.');
  });

  it('marks Slack setup onboarding jobs from the routing contract', async () => {
    const cloudJob = makeSlackAppMentionJob({
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

    mockTxExecute.mockResolvedValue([{ id: cloudJob.id }]);
    mockTxFindFirstCloudJobs.mockResolvedValue(cloudJob);
    mockResolveSlackJobRouting.mockResolvedValue({
      channel: 'C123',
      threadTs: '1710000000.000100',
      route: { kind: 'setup-onboarding', webPath: '/setup' },
    });

    const result = await dequeueCloudJob({ orgId: 'org-1' } as never, {
      cloudJobId: cloudJob.id,
    });

    expect(result?.setupOnboardingTask).toBe(true);
    expect(mockResolveSlackJobRouting).toHaveBeenCalledWith(cloudJob);
  });
  it('stamps startedAt before prompt generation begins', async () => {
    const cloudJob = makeStandardTaskJob();

    mockTxExecute.mockResolvedValue([{ id: cloudJob.id }]);
    mockTxFindFirstCloudJobs.mockResolvedValue(cloudJob);

    await dequeueCloudJob({ orgId: 'org-1' } as never, {
      cloudJobId: cloudJob.id,
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

  it('records a worker_bootstrap lifecycle event after the worker claims the job', async () => {
    const cloudJob = makeStandardTaskJob({
      vendor: 'modal',
      machineId: 'sb_123',
      sourceSnapshotId: 'snap_env_123',
      payload: {
        repo: 'owner/repo',
        description: 'Investigate auth flakes',
        environmentId: '11111111-1111-4111-8111-111111111111',
      },
    });

    mockTxExecute.mockResolvedValue([{ id: cloudJob.id }]);
    mockTxFindFirstCloudJobs.mockResolvedValue(cloudJob);

    await dequeueCloudJob({ orgId: 'org-1' } as never, {
      cloudJobId: cloudJob.id,
    });

    expect(mockRecordJobLifecycleEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: cloudJob.id,
        taskId: cloudJob.taskId,
        eventType: 'started',
        message: expect.stringContaining('started execution bootstrap'),
        details: expect.objectContaining({
          stage: 'worker_bootstrap',
          status: CloudTaskStatus.Processing,
          vendor: 'modal',
          machineId: 'sb_123',
          sourceSnapshotId: 'snap_env_123',
          environmentId: '11111111-1111-4111-8111-111111111111',
          cloudTaskType: TaskPayloadKind.StandardTask,
        }),
      }),
    );
  });

  it('records bootstrap phase events for token, prompt, env resolution, and routing', async () => {
    const cloudJob = makeStandardTaskJob();

    mockTxExecute.mockResolvedValue([{ id: cloudJob.id }]);
    mockTxFindFirstCloudJobs.mockResolvedValue(cloudJob);

    await dequeueCloudJob({ orgId: 'org-1' } as never, {
      cloudJobId: cloudJob.id,
    });

    expect(mockRecordJobLifecycleEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: cloudJob.id,
        taskId: cloudJob.taskId,
        eventType: 'phase',
        message: 'createSourceControlToken',
        details: expect.objectContaining({
          phase: 'createSourceControlToken',
          outcome: 'ok',
          durationMs: expect.any(Number),
          cloudTaskType: TaskPayloadKind.StandardTask,
          provider: 'github',
        }),
      }),
    );
    expect(mockRecordJobLifecycleEvent).toHaveBeenCalledWith(
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
    expect(mockRecordJobLifecycleEvent).toHaveBeenCalledWith(
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
    expect(mockRecordJobLifecycleEvent).toHaveBeenCalledWith(
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
    const cloudJob = makeStandardTaskJob();

    mockTxExecute.mockResolvedValue([{ id: cloudJob.id }]);
    mockTxFindFirstCloudJobs.mockResolvedValue(cloudJob);
    mockCreateSourceControlTokenForJob.mockResolvedValueOnce(null);

    const result = await dequeueCloudJob({ orgId: 'org-1' } as never, {
      cloudJobId: cloudJob.id,
    });

    expect(result).toBeUndefined();
    expect(mockRecordJobLifecycleEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: cloudJob.id,
        taskId: cloudJob.taskId,
        eventType: 'phase',
        message: 'createSourceControlToken',
        details: expect.objectContaining({
          phase: 'createSourceControlToken',
          outcome: 'failed',
          durationMs: expect.any(Number),
          error: expect.stringContaining('returned no token'),
          cloudTaskType: TaskPayloadKind.StandardTask,
          provider: 'github',
        }),
      }),
    );
    expect(mockCancelAndReleaseCloudJob).toHaveBeenCalledWith(
      cloudJob,
      'Failed to create source control token.',
      expect.any(String),
    );
  });

  it('skips slackThreadTs persistence when the job is not Slack-originated', async () => {
    const cloudJob = makeStandardTaskJob();

    mockTxExecute.mockResolvedValue([{ id: cloudJob.id }]);
    mockTxFindFirstCloudJobs.mockResolvedValue(cloudJob);

    const result = await dequeueCloudJob({ orgId: 'org-1' } as never, {
      cloudJobId: cloudJob.id,
    });

    expect(result?.cloudJob.id).toBe(cloudJob.id);
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
    const cloudJob = makeSlackAppMentionJob();

    mockTxExecute.mockResolvedValue([{ id: cloudJob.id }]);
    mockTxFindFirstCloudJobs.mockResolvedValue(cloudJob);

    const result = await dequeueCloudJob({ orgId: 'org-1' } as never, {
      cloudJobId: cloudJob.id,
    });

    expect(result?.cloudJob.id).toBe(cloudJob.id);
    expect(
      mockTxUpdateSet.mock.calls.some(
        ([values]) =>
          values != null &&
          typeof values === 'object' &&
          'slackThreadTs' in (values as Record<string, unknown>),
      ),
    ).toBe(false);
  });

  it('keeps implicit Generalist jobs runnable during dequeue', async () => {
    const cloudJob = makeStandardTaskJob();

    mockTxExecute.mockResolvedValue([{ id: cloudJob.id }]);
    mockTxFindFirstCloudJobs.mockResolvedValue(cloudJob);

    await dequeueCloudJob({ orgId: 'org-1' } as never, {
      cloudJobId: cloudJob.id,
    });

    expect(mockGeneratePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        cloudJob,
        cloudTask: expect.objectContaining({
          type: TaskPayloadKind.StandardTask,
        }),
      }),
    );
    expect(mockCancelCloudJob).not.toHaveBeenCalledWith(
      expect.anything(),
      cloudJob.id,
      'Cloud job is not valid.',
    );
  });

  it('invokes the bootstrap failure callback before canceling an invalid job', async () => {
    const cloudJob = makeStandardTaskJob({
      payloadKind: TaskPayloadKind.GithubPrReview,
      payload: {
        repo: 'owner/repo',
        prNumber: '42' as never,
        prTitle: 'Fix it',
        prUrl: 'https://github.com/owner/repo/pull/42',
        headSha: '1234567890abcdef1234567890abcdef12345678',
      },
    });

    mockTxExecute.mockResolvedValue([{ id: cloudJob.id }]);
    mockTxFindFirstCloudJobs.mockResolvedValue(cloudJob);
    const result = await dequeueCloudJob(
      { orgId: 'org-1' } as never,
      {
        cloudJobId: cloudJob.id,
      },
      {
        onBootstrapFailure: onBootstrapFailureMock,
      },
    );

    expect(result).toBeUndefined();
    expect(onBootstrapFailureMock).toHaveBeenCalledTimes(1);
    expect(onBootstrapFailureMock).toHaveBeenCalledWith(
      expect.any(Error),
      cloudJob,
    );
    expect(mockCancelCloudJob).toHaveBeenCalledWith(
      expect.anything(),
      cloudJob.id,
      'Cloud job is not valid.',
      expect.objectContaining({
        bootstrapFailureReason: 'schema_validation_failed',
        existingArtifacts: cloudJob.artifacts,
      }),
    );
  });

  it('cancels the cloud job when launch metadata persistence fails for PR review jobs', async () => {
    const cloudJob = makeStandardTaskJob({
      payloadKind: TaskPayloadKind.GithubPrReview,
      payload: {
        repo: 'owner/repo',
        prNumber: 42,
        prTitle: 'Fix it',
        prUrl: 'https://github.com/owner/repo/pull/42',
        headSha: '1234567890abcdef1234567890abcdef12345678',
      },
    });

    mockTxExecute.mockResolvedValue([{ id: cloudJob.id }]);
    mockTxFindFirstCloudJobs.mockResolvedValue(cloudJob);
    mockTxUpdateWhere
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('write failed'));

    const result = await dequeueCloudJob({ orgId: 'org-1' } as never, {
      cloudJobId: cloudJob.id,
    });

    expect(result).toBeUndefined();
    expect(mockCancelAndReleaseCloudJob).toHaveBeenCalledWith(
      cloudJob,
      expect.stringContaining('Failed to persist launch metadata'),
      '[dequeueCloudJob]',
    );
  });
});
