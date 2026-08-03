import { RunStatus, TaskPayloadKind } from '@roomote/types';
import type { TaskRun } from '@roomote/db/server';

const {
  mockDbTransaction,
  mockEq,
  mockTxFindFirstBackgroundAgentSettings,
  mockTxExecute,
  mockTxFindFirstTaskRuns,
  mockTxUpdate,
  mockTxUpdateSet,
  mockTxUpdateWhere,
  mockReleaseTaskRun,
  mockUpdateTaskRun,
  mockClaimJobById,
  mockFetchEnvVars,
  mockFetchResolvedRuntimeEnvVars,
  mockCancelAndReleaseTaskRun,
  mockNotifyCanceledTaskRunOnSettle,
  mockCreateSourceControlTokenForTaskRun,
  mockCancelTaskRun,
  mockReportBootstrapFailure,
  mockResolveGitAuthor,
  mockRecordTaskRunLifecycleEvent,
  mockRecordSnapshotResumeEvent,
  mockResolveSlackTaskRunRouting,
  onBootstrapFailureMock,
} = vi.hoisted(() => ({
  mockDbTransaction: vi.fn(),
  mockEq: vi.fn(),
  mockTxFindFirstBackgroundAgentSettings: vi.fn(),
  mockTxExecute: vi.fn(),
  mockTxFindFirstTaskRuns: vi.fn(),
  mockTxUpdateWhere: vi.fn(),
  mockTxUpdateSet: vi.fn(),
  mockTxUpdate: vi.fn(),
  mockReleaseTaskRun: vi.fn(),
  mockUpdateTaskRun: vi.fn(),
  mockClaimJobById: vi.fn(),
  mockFetchEnvVars: vi.fn(),
  mockFetchResolvedRuntimeEnvVars: vi.fn(),
  mockCancelAndReleaseTaskRun: vi.fn(),
  mockNotifyCanceledTaskRunOnSettle: vi.fn(),
  mockCreateSourceControlTokenForTaskRun: vi.fn(),
  mockCancelTaskRun: vi.fn(),
  mockReportBootstrapFailure: vi.fn(),
  mockResolveGitAuthor: vi.fn(),
  mockRecordTaskRunLifecycleEvent: vi.fn(),
  mockRecordSnapshotResumeEvent: vi.fn(),
  mockResolveSlackTaskRunRouting: vi.fn(),
  onBootstrapFailureMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    transaction: (...args: unknown[]) => mockDbTransaction(...args),
  },
  deploymentSettings: { orgId: 'deploymentSettings.orgId' },
  taskRuns: {},
  tasks: {},
  eq: (...args: unknown[]) => mockEq(...args),
  recordTaskRunLifecycleEvent: (...args: unknown[]) =>
    mockRecordTaskRunLifecycleEvent(...args),
  recordSnapshotResumeEvent: (...args: unknown[]) =>
    mockRecordSnapshotResumeEvent(...args),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  releaseTaskRun: (...args: unknown[]) => mockReleaseTaskRun(...args),
}));

vi.mock('../update-task-run', () => ({
  updateTaskRun: (...args: unknown[]) => mockUpdateTaskRun(...args),
}));

vi.mock('../dequeue-helpers', () => ({
  claimJobById: (...args: unknown[]) => mockClaimJobById(...args),
  fetchEnvVars: (...args: unknown[]) => mockFetchEnvVars(...args),
  fetchResolvedRuntimeEnvVars: (...args: unknown[]) =>
    mockFetchResolvedRuntimeEnvVars(...args),
  flattenResolvedRuntimeEnvVars: (resolved: {
    envVars: Record<string, string>;
    modelRuntimeEnv: Record<string, string>;
  }) => ({ ...resolved.envVars, ...resolved.modelRuntimeEnv }),
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
}));

vi.mock('../slack-task-run-routing', () => ({
  resolveSlackTaskRunRouting: (...args: unknown[]) =>
    mockResolveSlackTaskRunRouting(...args),
}));

import { dequeueResumeTaskRun } from '../dequeue-resume-task-run';

type RunWithTask = TaskRun & { task: Record<string, unknown> };

function makeTaskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-101',
    title: 'Task 101',
    prompt: null,
    harnessSessionId: 'session-canonical',
    harnessInstructions: 'preserved instructions',
    requestedWorkKind: 'unknown',
    slackChannelId: null,
    slackThreadTs: null,
    linearSessionId: null,
    linearIssueId: null,
    linearOrganizationId: null,
    ...overrides,
  };
}

function makeSnapshotResumeRun(
  overrides: Partial<RunWithTask> = {},
  taskOverrides: Record<string, unknown> = {},
): RunWithTask {
  return {
    id: 101,
    harness: 'opencode-server',
    status: RunStatus.Dequeued,
    kind: 'resume',
    payloadKind: TaskPayloadKind.SnapshotResume,
    taskId: 'task-101',
    sourceRunId: 99,
    sourceSnapshotId: 'snap-1',
    payload: {
      sourceRunId: 99,
      sourceSnapshotId: 'snap-1',
      repo: 'owner/repo',
      environmentId: 'env-1',
      selectedRepositories: ['acme/api', 'acme/web'],
    },
    result: null,
    task: makeTaskRow(taskOverrides),
    ...overrides,
  } as RunWithTask;
}

describe('dequeueResumeTaskRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockEq.mockReturnValue('eq-clause');
    mockClaimJobById.mockReturnValue('claim-query');
    mockFetchEnvVars.mockResolvedValue({ ORG_ENV: '1' });
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
    mockFetchResolvedRuntimeEnvVars.mockResolvedValue({
      envVars: { RESOLVED_ENV: '1' },
      modelRuntimeEnv: {},
    });
    mockCancelTaskRun.mockResolvedValue(undefined);
    mockCancelAndReleaseTaskRun.mockResolvedValue(undefined);
    mockReleaseTaskRun.mockResolvedValue(true);
    mockUpdateTaskRun.mockResolvedValue(undefined);
    mockRecordSnapshotResumeEvent.mockResolvedValue(undefined);
    mockTxFindFirstBackgroundAgentSettings.mockResolvedValue(undefined);
    mockResolveSlackTaskRunRouting.mockResolvedValue({
      channel: null,
      threadTs: null,
      route: { kind: 'task', webPath: null },
    });
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

    mockTxUpdateWhere.mockResolvedValue(undefined);
    mockTxUpdateSet.mockImplementation((..._args: unknown[]) => ({
      where: (...args: unknown[]) => mockTxUpdateWhere(...args),
    }));
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

  it("returns the task's harnessSessionId for snapshot resume", async () => {
    const resumeRun = makeSnapshotResumeRun();

    mockTxExecute.mockResolvedValue([{ id: resumeRun.id }]);
    mockTxFindFirstTaskRuns.mockResolvedValueOnce(resumeRun);

    const result = await dequeueResumeTaskRun({ orgId: 'org-1' } as never, {
      runId: resumeRun.id,
    });

    expect(result?.harnessSessionId).toBe('session-canonical');
    expect(result?.harnessInstructions).toBe('preserved instructions');
    expect(result?.sourceSelectedRepositories).toEqual([
      'acme/api',
      'acme/web',
    ]);
    expect(result?.task).toMatchObject({
      id: 'task-101',
      harnessInstructions: 'preserved instructions',
    });
    expect(mockRecordSnapshotResumeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: resumeRun.id,
        eventType: 'started',
        message: expect.stringContaining('session-canonical'),
        details: expect.objectContaining({
          stage: 'bootstrap',
          sourceRunId: 99,
          sourceSnapshotId: 'snap-1',
          harnessSessionId: 'session-canonical',
          sourceRepo: 'owner/repo',
          sourceEnvironmentId: 'env-1',
          selectedRepositories: ['acme/api', 'acme/web'],
        }),
      }),
    );
    expect(mockRecordTaskRunLifecycleEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: resumeRun.id,
        taskId: resumeRun.taskId,
        eventType: 'started',
        message: expect.stringContaining('started resume bootstrap'),
        details: expect.objectContaining({
          stage: 'worker_bootstrap',
          status: RunStatus.Processing,
          sourceSnapshotId: 'snap-1',
          sourceRunId: 99,
          harnessSessionId: 'session-canonical',
          sourceRepo: 'owner/repo',
          sourceEnvironmentId: 'env-1',
          selectedRepositories: ['acme/api', 'acme/web'],
          payloadKind: TaskPayloadKind.SnapshotResume,
        }),
      }),
    );
  });

  it('marks resumed setup onboarding jobs when routing resolves /setup', async () => {
    const resumeRun = makeSnapshotResumeRun();

    mockTxExecute.mockResolvedValue([{ id: resumeRun.id }]);
    mockTxFindFirstTaskRuns.mockResolvedValueOnce(resumeRun);
    mockResolveSlackTaskRunRouting.mockResolvedValue({
      channel: 'C123',
      threadTs: '1710000000.000100',
      route: { kind: 'setup-onboarding', webPath: '/setup' },
    });

    const result = await dequeueResumeTaskRun({ orgId: 'org-1' } as never, {
      runId: resumeRun.id,
    });

    expect(result?.setupOnboardingTask).toBe(true);
    expect(mockResolveSlackTaskRunRouting).toHaveBeenCalledWith(resumeRun);
  });

  it('persists worker runtime metadata when the resume worker claims the run', async () => {
    const resumeRun = makeSnapshotResumeRun();

    mockTxExecute.mockResolvedValue([{ id: resumeRun.id }]);
    mockTxFindFirstTaskRuns.mockResolvedValueOnce(resumeRun);

    await dequeueResumeTaskRun({ orgId: 'org-1' } as never, {
      runId: resumeRun.id,
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
    const resumeRun = makeSnapshotResumeRun();

    mockTxExecute.mockResolvedValue([{ id: resumeRun.id }]);
    mockTxFindFirstTaskRuns.mockResolvedValueOnce(resumeRun);
    mockTxFindFirstBackgroundAgentSettings.mockResolvedValue({
      globalAgentInstructions: 'Mention the affected environment in updates.',
    });

    const result = await dequeueResumeTaskRun({ orgId: 'org-1' } as never, {
      runId: resumeRun.id,
    });

    expect(result?.orgAgentInstructions).toBe(
      'Mention the affected environment in updates.',
    );
  });

  it('fails fast when the task has no harnessSessionId', async () => {
    const resumeRun = makeSnapshotResumeRun({}, { harnessSessionId: null });

    mockTxExecute.mockResolvedValue([{ id: resumeRun.id }]);
    mockTxFindFirstTaskRuns.mockResolvedValueOnce(resumeRun);

    const result = await dequeueResumeTaskRun({ orgId: 'org-1' } as never, {
      runId: resumeRun.id,
    });

    expect(result).toBeUndefined();
    expect(mockCancelTaskRun).toHaveBeenCalledWith(
      expect.anything(),
      resumeRun.id,
      expect.stringContaining('has no harnessSessionId to resume'),
      expect.objectContaining({
        bootstrapFailureReason: 'missing_harness_session_id',
        existingArtifacts: resumeRun.artifacts,
      }),
    );
    expect(mockRecordSnapshotResumeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: resumeRun.id,
        eventType: 'failed',
        details: expect.objectContaining({
          stage: 'bootstrap',
          reason: 'missing_harness_session_id',
          sourceRunId: 99,
          sourceSnapshotId: 'snap-1',
          sourceTaskId: 'task-101',
        }),
      }),
    );
    expect(mockReleaseTaskRun).toHaveBeenCalledWith(resumeRun);
  });

  it.each(['docker', 'blaxel'] as const)(
    'resumes a retained %s environment before its first harness session',
    async (vendor) => {
      const resumeRun = makeSnapshotResumeRun(
        { vendor },
        { harnessSessionId: null },
      );

      mockTxExecute.mockResolvedValue([{ id: resumeRun.id }]);
      mockTxFindFirstTaskRuns.mockResolvedValueOnce(resumeRun);

      const result = await dequeueResumeTaskRun({ orgId: 'org-1' } as never, {
        runId: resumeRun.id,
      });

      expect(result?.harnessSessionId).toBeUndefined();
      expect(mockCancelTaskRun).not.toHaveBeenCalled();
      expect(mockRecordSnapshotResumeEvent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          runId: resumeRun.id,
          eventType: 'started',
          message: expect.stringContaining('before the first harness session'),
          details: expect.objectContaining({
            harnessSessionId: undefined,
            sourceRunId: 99,
            sourceSnapshotId: 'snap-1',
          }),
        }),
      );
    },
  );

  it('invokes the bootstrap failure callback when resume bootstrap fails before startup', async () => {
    const resumeRun = makeSnapshotResumeRun({}, { harnessSessionId: null });

    mockTxExecute.mockResolvedValue([{ id: resumeRun.id }]);
    mockTxFindFirstTaskRuns.mockResolvedValueOnce(resumeRun);

    const result = await dequeueResumeTaskRun(
      { orgId: 'org-1' } as never,
      {
        runId: resumeRun.id,
      },
      {
        onBootstrapFailure: onBootstrapFailureMock,
      },
    );

    expect(result).toBeUndefined();
    expect(onBootstrapFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('has no harnessSessionId to resume'),
      }),
      resumeRun,
    );
  });

  it('uses the same error message for invalid resume task run type in the callback and canceled task run row', async () => {
    const invalidRun = makeSnapshotResumeRun({
      payloadKind: TaskPayloadKind.StandardTask,
    });

    mockTxExecute.mockResolvedValue([{ id: invalidRun.id }]);
    mockTxFindFirstTaskRuns.mockResolvedValueOnce(invalidRun);

    await dequeueResumeTaskRun(
      { orgId: 'org-1' } as never,
      {
        runId: invalidRun.id,
      },
      {
        onBootstrapFailure: onBootstrapFailureMock,
      },
    );

    const callbackError = onBootstrapFailureMock.mock.calls[0]?.[0] as
      | Error
      | undefined;
    const cancelReason = mockCancelTaskRun.mock.calls[0]?.[2];

    expect(callbackError?.message).toBe(cancelReason);
    expect(cancelReason).toBe(
      `Expected SnapshotResume run, got ${invalidRun.payloadKind}`,
    );
    expect(mockCancelTaskRun.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({
        bootstrapFailureReason: 'invalid_run_kind',
        existingArtifacts: invalidRun.artifacts,
      }),
    );
    expect(mockNotifyCanceledTaskRunOnSettle).toHaveBeenCalledWith(invalidRun);
  });

  it('uses the same error message for a missing source run id in the callback and canceled task run row', async () => {
    const invalidRun = makeSnapshotResumeRun({
      sourceRunId: null,
      payload: {
        sourceRunId: undefined,
        sourceSnapshotId: 'snap-1',
        repo: 'owner/repo',
        environmentId: 'env-1',
        selectedRepositories: ['acme/api', 'acme/web'],
      },
    });

    mockTxExecute.mockResolvedValue([{ id: invalidRun.id }]);
    mockTxFindFirstTaskRuns.mockResolvedValueOnce(invalidRun);

    await dequeueResumeTaskRun(
      { orgId: 'org-1' } as never,
      {
        runId: invalidRun.id,
      },
      {
        onBootstrapFailure: onBootstrapFailureMock,
      },
    );

    const callbackError = onBootstrapFailureMock.mock.calls[0]?.[0] as
      | Error
      | undefined;
    const cancelReason = mockCancelTaskRun.mock.calls[0]?.[2];

    expect(callbackError?.message).toBe(cancelReason);
    expect(cancelReason).toBe(
      `Snapshot-resume run ${invalidRun.id} has no source run id`,
    );
    expect(mockCancelTaskRun.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({
        bootstrapFailureReason: 'missing_source_task_run_id',
        existingArtifacts: invalidRun.artifacts,
      }),
    );
  });

  it('resumes snapshot runs without requiring persisted agent state', async () => {
    const resumeRun = makeSnapshotResumeRun();

    mockTxExecute.mockResolvedValue([{ id: resumeRun.id }]);
    mockTxFindFirstTaskRuns.mockResolvedValueOnce(resumeRun);

    await dequeueResumeTaskRun({ orgId: 'org-1' } as never, {
      runId: resumeRun.id,
    });
    expect(mockCancelTaskRun).not.toHaveBeenCalled();
  });
});
