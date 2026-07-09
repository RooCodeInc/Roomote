import { CloudTaskStatus, TaskPayloadKind } from '@roomote/types';
import type { CloudJob } from '@roomote/db/server';

const {
  mockDbTransaction,
  mockEq,
  mockTxFindFirstBackgroundAgentSettings,
  mockTxExecute,
  mockTxFindFirstCloudJobs,
  mockTxUpdate,
  mockTxUpdateSet,
  mockTxUpdateWhere,
  mockReleaseCloudTask,
  mockUpdateCloudJob,
  mockClaimJobById,
  mockFetchEnvVars,
  mockFetchResolvedRuntimeEnvVars,
  mockCancelAndReleaseCloudJob,
  mockCreateSourceControlTokenForJob,
  mockCancelCloudJob,
  mockReportBootstrapFailure,
  mockResolveGitAuthor,
  mockRecordJobLifecycleEvent,
  mockRecordSnapshotResumeEvent,
  mockResolveSlackJobRouting,
  onBootstrapFailureMock,
} = vi.hoisted(() => ({
  mockDbTransaction: vi.fn(),
  mockEq: vi.fn(),
  mockTxFindFirstBackgroundAgentSettings: vi.fn(),
  mockTxExecute: vi.fn(),
  mockTxFindFirstCloudJobs: vi.fn(),
  mockTxUpdateWhere: vi.fn(),
  mockTxUpdateSet: vi.fn(),
  mockTxUpdate: vi.fn(),
  mockReleaseCloudTask: vi.fn(),
  mockUpdateCloudJob: vi.fn(),
  mockClaimJobById: vi.fn(),
  mockFetchEnvVars: vi.fn(),
  mockFetchResolvedRuntimeEnvVars: vi.fn(),
  mockCancelAndReleaseCloudJob: vi.fn(),
  mockCreateSourceControlTokenForJob: vi.fn(),
  mockCancelCloudJob: vi.fn(),
  mockReportBootstrapFailure: vi.fn(),
  mockResolveGitAuthor: vi.fn(),
  mockRecordJobLifecycleEvent: vi.fn(),
  mockRecordSnapshotResumeEvent: vi.fn(),
  mockResolveSlackJobRouting: vi.fn(),
  onBootstrapFailureMock: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    transaction: (...args: unknown[]) => mockDbTransaction(...args),
  },
  backgroundAgentSettings: { orgId: 'backgroundAgentSettings.orgId' },
  taskRuns: {},
  tasks: {},
  eq: (...args: unknown[]) => mockEq(...args),
  recordJobLifecycleEvent: (...args: unknown[]) =>
    mockRecordJobLifecycleEvent(...args),
  recordSnapshotResumeEvent: (...args: unknown[]) =>
    mockRecordSnapshotResumeEvent(...args),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  releaseCloudTask: (...args: unknown[]) => mockReleaseCloudTask(...args),
}));

vi.mock('../update-cloud-job', () => ({
  updateCloudJob: (...args: unknown[]) => mockUpdateCloudJob(...args),
}));

vi.mock('../dequeue-helpers', () => ({
  claimJobById: (...args: unknown[]) => mockClaimJobById(...args),
  fetchEnvVars: (...args: unknown[]) => mockFetchEnvVars(...args),
  fetchResolvedRuntimeEnvVars: (...args: unknown[]) =>
    mockFetchResolvedRuntimeEnvVars(...args),
  cancelAndReleaseCloudJob: (...args: unknown[]) =>
    mockCancelAndReleaseCloudJob(...args),
  createSourceControlTokenForJob: (...args: unknown[]) =>
    mockCreateSourceControlTokenForJob(...args),
  cancelCloudJob: (...args: unknown[]) => mockCancelCloudJob(...args),
  reportBootstrapFailure: (...args: unknown[]) =>
    mockReportBootstrapFailure(...args),
  resolveGitAuthor: (...args: unknown[]) => mockResolveGitAuthor(...args),
}));

vi.mock('../slack-job-routing', () => ({
  resolveSlackJobRouting: (...args: unknown[]) =>
    mockResolveSlackJobRouting(...args),
}));

import { dequeueResumeCloudJob } from '../dequeue-resume-cloud-job';

type RunWithTask = CloudJob & { task: Record<string, unknown> };

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

function makeSnapshotResumeJob(
  overrides: Partial<RunWithTask> = {},
  taskOverrides: Record<string, unknown> = {},
): RunWithTask {
  return {
    id: 101,
    harness: 'opencode-server',
    status: CloudTaskStatus.Dequeued,
    kind: 'resume',
    payloadKind: TaskPayloadKind.SnapshotResume,
    taskId: 'task-101',
    sourceRunId: 99,
    sourceSnapshotId: 'snap-1',
    payload: {
      sourceCloudJobId: 99,
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

describe('dequeueResumeCloudJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockEq.mockReturnValue('eq-clause');
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
    mockUpdateCloudJob.mockResolvedValue(undefined);
    mockRecordSnapshotResumeEvent.mockResolvedValue(undefined);
    mockTxFindFirstBackgroundAgentSettings.mockResolvedValue(undefined);
    mockResolveSlackJobRouting.mockResolvedValue({
      channel: null,
      threadTs: null,
      route: { kind: 'task', webPath: null },
    });
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
          backgroundAgentSettings: {
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

  it("returns the task's harnessSessionId for snapshot resume", async () => {
    const resumeJob = makeSnapshotResumeJob();

    mockTxExecute.mockResolvedValue([{ id: resumeJob.id }]);
    mockTxFindFirstCloudJobs.mockResolvedValueOnce(resumeJob);

    const result = await dequeueResumeCloudJob({ orgId: 'org-1' } as never, {
      cloudJobId: resumeJob.id,
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
        runId: resumeJob.id,
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
    expect(mockRecordJobLifecycleEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: resumeJob.id,
        taskId: resumeJob.taskId,
        eventType: 'started',
        message: expect.stringContaining('started resume bootstrap'),
        details: expect.objectContaining({
          stage: 'worker_bootstrap',
          status: CloudTaskStatus.Processing,
          sourceSnapshotId: 'snap-1',
          sourceRunId: 99,
          harnessSessionId: 'session-canonical',
          sourceRepo: 'owner/repo',
          sourceEnvironmentId: 'env-1',
          selectedRepositories: ['acme/api', 'acme/web'],
          cloudTaskType: TaskPayloadKind.SnapshotResume,
        }),
      }),
    );
  });

  it('returns style guidance for resume jobs', async () => {
    const resumeJob = makeSnapshotResumeJob();

    mockTxExecute.mockResolvedValue([{ id: resumeJob.id }]);
    mockTxFindFirstCloudJobs.mockResolvedValueOnce(resumeJob);
    mockTxFindFirstBackgroundAgentSettings.mockResolvedValue({
      globalAgentInstructions: 'Org guidance',
      styleGuidance: 'Be direct and calm.',
    });

    const result = await dequeueResumeCloudJob({ orgId: 'org-1' } as never, {
      cloudJobId: resumeJob.id,
    });

    expect(result?.styleGuidance).toBe('Be direct and calm.');
  });

  it('marks resumed setup onboarding jobs when routing resolves /setup', async () => {
    const resumeJob = makeSnapshotResumeJob();

    mockTxExecute.mockResolvedValue([{ id: resumeJob.id }]);
    mockTxFindFirstCloudJobs.mockResolvedValueOnce(resumeJob);
    mockResolveSlackJobRouting.mockResolvedValue({
      channel: 'C123',
      threadTs: '1710000000.000100',
      route: { kind: 'setup-onboarding', webPath: '/setup' },
    });

    const result = await dequeueResumeCloudJob({ orgId: 'org-1' } as never, {
      cloudJobId: resumeJob.id,
    });

    expect(result?.setupOnboardingTask).toBe(true);
    expect(mockResolveSlackJobRouting).toHaveBeenCalledWith(resumeJob);
  });

  it('persists worker runtime metadata when the resume worker claims the job', async () => {
    const resumeJob = makeSnapshotResumeJob();

    mockTxExecute.mockResolvedValue([{ id: resumeJob.id }]);
    mockTxFindFirstCloudJobs.mockResolvedValueOnce(resumeJob);

    await dequeueResumeCloudJob({ orgId: 'org-1' } as never, {
      cloudJobId: resumeJob.id,
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
    const resumeJob = makeSnapshotResumeJob();

    mockTxExecute.mockResolvedValue([{ id: resumeJob.id }]);
    mockTxFindFirstCloudJobs.mockResolvedValueOnce(resumeJob);
    mockTxFindFirstBackgroundAgentSettings.mockResolvedValue({
      globalAgentInstructions: 'Mention the affected environment in updates.',
    });

    const result = await dequeueResumeCloudJob({ orgId: 'org-1' } as never, {
      cloudJobId: resumeJob.id,
    });

    expect(result?.orgAgentInstructions).toBe(
      'Mention the affected environment in updates.',
    );
  });

  it('fails fast when the task has no harnessSessionId', async () => {
    const resumeJob = makeSnapshotResumeJob({}, { harnessSessionId: null });

    mockTxExecute.mockResolvedValue([{ id: resumeJob.id }]);
    mockTxFindFirstCloudJobs.mockResolvedValueOnce(resumeJob);

    const result = await dequeueResumeCloudJob({ orgId: 'org-1' } as never, {
      cloudJobId: resumeJob.id,
    });

    expect(result).toBeUndefined();
    expect(mockCancelCloudJob).toHaveBeenCalledWith(
      expect.anything(),
      resumeJob.id,
      expect.stringContaining('has no harnessSessionId to resume'),
      expect.objectContaining({
        bootstrapFailureReason: 'missing_harness_session_id',
        existingArtifacts: resumeJob.artifacts,
      }),
    );
    expect(mockRecordSnapshotResumeEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: resumeJob.id,
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
    expect(mockReleaseCloudTask).toHaveBeenCalledWith(resumeJob);
  });

  it('invokes the bootstrap failure callback when resume bootstrap fails before startup', async () => {
    const resumeJob = makeSnapshotResumeJob({}, { harnessSessionId: null });

    mockTxExecute.mockResolvedValue([{ id: resumeJob.id }]);
    mockTxFindFirstCloudJobs.mockResolvedValueOnce(resumeJob);

    const result = await dequeueResumeCloudJob(
      { orgId: 'org-1' } as never,
      {
        cloudJobId: resumeJob.id,
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
      resumeJob,
    );
  });

  it('uses the same error message for invalid resume job type in the callback and canceled job row', async () => {
    const invalidJob = makeSnapshotResumeJob({
      payloadKind: TaskPayloadKind.StandardTask,
    });

    mockTxExecute.mockResolvedValue([{ id: invalidJob.id }]);
    mockTxFindFirstCloudJobs.mockResolvedValueOnce(invalidJob);

    await dequeueResumeCloudJob(
      { orgId: 'org-1' } as never,
      {
        cloudJobId: invalidJob.id,
      },
      {
        onBootstrapFailure: onBootstrapFailureMock,
      },
    );

    const callbackError = onBootstrapFailureMock.mock.calls[0]?.[0] as
      | Error
      | undefined;
    const cancelReason = mockCancelCloudJob.mock.calls[0]?.[2];

    expect(callbackError?.message).toBe(cancelReason);
    expect(cancelReason).toBe(
      `Expected SnapshotResume run, got ${invalidJob.payloadKind}`,
    );
    expect(mockCancelCloudJob.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({
        bootstrapFailureReason: 'invalid_job_type',
        existingArtifacts: invalidJob.artifacts,
      }),
    );
  });

  it('uses the same error message for a missing source run id in the callback and canceled job row', async () => {
    const invalidJob = makeSnapshotResumeJob({
      sourceRunId: null,
      payload: {
        sourceCloudJobId: undefined,
        sourceSnapshotId: 'snap-1',
        repo: 'owner/repo',
        environmentId: 'env-1',
        selectedRepositories: ['acme/api', 'acme/web'],
      },
    });

    mockTxExecute.mockResolvedValue([{ id: invalidJob.id }]);
    mockTxFindFirstCloudJobs.mockResolvedValueOnce(invalidJob);

    await dequeueResumeCloudJob(
      { orgId: 'org-1' } as never,
      {
        cloudJobId: invalidJob.id,
      },
      {
        onBootstrapFailure: onBootstrapFailureMock,
      },
    );

    const callbackError = onBootstrapFailureMock.mock.calls[0]?.[0] as
      | Error
      | undefined;
    const cancelReason = mockCancelCloudJob.mock.calls[0]?.[2];

    expect(callbackError?.message).toBe(cancelReason);
    expect(cancelReason).toBe(
      `Snapshot-resume run ${invalidJob.id} has no source run id`,
    );
    expect(mockCancelCloudJob.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({
        bootstrapFailureReason: 'missing_source_cloud_job_id',
        existingArtifacts: invalidJob.artifacts,
      }),
    );
  });

  it('resumes snapshot jobs without requiring persisted agent state', async () => {
    const resumeJob = makeSnapshotResumeJob();

    mockTxExecute.mockResolvedValue([{ id: resumeJob.id }]);
    mockTxFindFirstCloudJobs.mockResolvedValueOnce(resumeJob);

    await dequeueResumeCloudJob({ orgId: 'org-1' } as never, {
      cloudJobId: resumeJob.id,
    });
    expect(mockCancelCloudJob).not.toHaveBeenCalled();
  });
});
