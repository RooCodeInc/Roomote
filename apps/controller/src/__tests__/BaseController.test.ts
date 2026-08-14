import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RunStatus, TaskPayloadKind, TaskRunErrorCode } from '@roomote/types';
import type { TaskRun } from '@roomote/db/server';

// ── Mocks ────────────────────────────────────────────────────────────────────

const {
  mockFinishRun,
  mockCaptureControllerException,
  mockCaptureControllerMessage,
  mockTaskRunsFindFirst,
  mockTaskRunsFindMany,
  mockOrgsFindFirst,
  mockDequeueTaskRun,
  mockFindPersistedWorkerBootstrapRestarts,
  mockGetOrphanedTaskRun,
  mockReadManagedDeploymentAccess,
  mockRecordTaskRunLifecycleEvent,
  mockRedisSet,
  mockUpdateWhere,
  mockSyncTaskStateFromRuns,
} = vi.hoisted(() => ({
  mockFinishRun: vi.fn().mockResolvedValue(undefined),
  mockCaptureControllerException: vi.fn(),
  mockCaptureControllerMessage: vi.fn(),
  mockTaskRunsFindFirst: vi.fn(),
  mockTaskRunsFindMany: vi.fn(),
  mockOrgsFindFirst: vi.fn(),
  mockDequeueTaskRun: vi.fn().mockResolvedValue(null),
  mockFindPersistedWorkerBootstrapRestarts: vi.fn().mockResolvedValue([]),
  mockGetOrphanedTaskRun: vi.fn().mockResolvedValue(null),
  mockReadManagedDeploymentAccess: vi.fn().mockResolvedValue({
    state: 'active',
    reason: null,
    revision: 0,
    effectiveAt: '1970-01-01T00:00:00.000Z',
    restrictionStartsAt: null,
    remediationUrl: null,
  }),
  mockRecordTaskRunLifecycleEvent: vi.fn().mockResolvedValue(undefined),
  mockRedisSet: vi.fn().mockResolvedValue('OK'),
  mockUpdateWhere: vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue([{}]),
  }),
  mockSyncTaskStateFromRuns: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@roomote/sdk/server', () => ({
  finishRun: (...args: unknown[]) => mockFinishRun(...args),
}));

const mockDbUpdateSet = vi.fn().mockReturnValue({
  where: (...args: unknown[]) => mockUpdateWhere(...args),
});
const mockDbUpdate = vi.fn().mockReturnValue({ set: mockDbUpdateSet });
const mockDbInsertValues = vi.fn().mockReturnValue({
  onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
});
const mockDbInsert = vi.fn().mockReturnValue({ values: mockDbInsertValues });
const mockUpdatePendingEnvironmentSnapshot = vi.fn().mockResolvedValue(true);
const mockDbTransaction = vi.fn();
const mockDbExecute = vi.fn().mockResolvedValue([]);

vi.mock('@roomote/db/server', async () => {
  const actual =
    await vi.importActual<typeof import('@roomote/db/server')>(
      '@roomote/db/server',
    );
  return {
    ...actual,
    db: {
      query: {
        taskRuns: {
          findFirst: (...args: unknown[]) => mockTaskRunsFindFirst(...args),
          findMany: (...args: unknown[]) => mockTaskRunsFindMany(...args),
        },
        orgs: { findFirst: (...args: unknown[]) => mockOrgsFindFirst(...args) },
      },
      insert: (...args: unknown[]) => mockDbInsert(...args),
      transaction: (...args: unknown[]) => mockDbTransaction(...args),
      update: (...args: unknown[]) => mockDbUpdate(...args),
      execute: (...args: unknown[]) => mockDbExecute(...args),
    },
    recordTaskRunLifecycleEvent: (...args: unknown[]) =>
      mockRecordTaskRunLifecycleEvent(...args),
    readManagedDeploymentAccess: (...args: unknown[]) =>
      mockReadManagedDeploymentAccess(...args),
    resolveDefaultComputeProvider: vi.fn().mockResolvedValue('docker'),
    syncTaskStateFromRuns: (...args: unknown[]) =>
      mockSyncTaskStateFromRuns(...args),
    updatePendingEnvironmentSnapshot: (...args: unknown[]) =>
      mockUpdatePendingEnvironmentSnapshot(...args),
  };
});

vi.mock('@roomote/auth', () => ({
  createRunToken: vi.fn().mockResolvedValue('test-token'),
}));

vi.mock('@roomote/redis', () => ({
  getRedis: vi.fn().mockReturnValue({
    set: (...args: unknown[]) => mockRedisSet(...args),
  }),
  REDIS_KEYS: { CONTROLLER_HEARTBEAT: 'controller:heartbeat' },
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  dequeueTaskRun: (...args: unknown[]) => mockDequeueTaskRun(...args),
}));

vi.mock('../orphaned-task-runs', () => ({
  getOrphanedTaskRun: (...args: unknown[]) => mockGetOrphanedTaskRun(...args),
}));

vi.mock('../worker-bootstrap-restarts', () => ({
  findPersistedWorkerBootstrapRestarts: (...args: unknown[]) =>
    mockFindPersistedWorkerBootstrapRestarts(...args),
}));

vi.mock('../monitoring/sentry', () => ({
  captureControllerException: (...args: unknown[]) =>
    mockCaptureControllerException(...args),
  captureControllerMessage: (...args: unknown[]) =>
    mockCaptureControllerMessage(...args),
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import { BaseController } from '../BaseController';
import { DockerBootError } from '../compute-providers/docker-sandbox-security';

// Create a concrete subclass for testing the abstract BaseController.
class TestController extends BaseController {
  constructor() {
    super('development');
  }

  protected async spawnFreshWorker(
    _taskRun: TaskRun,
    _authToken: string,
    _deploymentSlug: string,
    _sandboxTimeoutMs: number,
  ): Promise<void> {
    // no-op for testing
  }

  // Expose handleSpawnTaskRunError for direct testing.
  public async testHandleSpawnTaskRunError(
    taskRun: TaskRun,
    error: unknown,
  ): Promise<void> {
    return this.handleSpawnTaskRunError(taskRun, error);
  }

  public getLocalReleasePaths() {
    return {
      localWorkerReleasePath: this.localWorkerReleasePath,
    };
  }

  public async testDequeueTaskRun(taskRun: TaskRun) {
    return this.dequeueTaskRun(taskRun);
  }

  public async testHandleWorkerExitBeforeStart(
    taskRun: TaskRun,
    exitCode: number,
    launchDiagnostics?: string,
  ) {
    return this.handleWorkerExitBeforeStart(
      taskRun,
      exitCode,
      launchDiagnostics,
    );
  }

  public async testFailTimedOutWorkerBootstraps() {
    return this.failTimedOutWorkerBootstraps();
  }

  public async testRecoverPersistedWorkerBootstrapRestarts() {
    return this.recoverPersistedWorkerBootstrapRestarts();
  }
}

class SaturatedTestController extends TestController {
  protected readonly MAX_CONCURRENT_SPAWNS: number = 0;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTaskRun(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 42,
    payloadKind: TaskPayloadKind.StandardTask,
    userId: 'user-1',
    harness: 'opencode-server',
    status: RunStatus.Running,
    payload: { repo: 'owner/repo' },
    taskId: 'task-1',
    slackThreadTs: null,
    linearSessionId: null,
    linearIssueId: null,
    linearOrganizationId: null,
    githubPrReactionId: null,
    githubPrCheckRunId: null,
    githubPrReviewCommentId: null,
    prRepo: null,
    prNumber: null,
    prSha: null,
    canceledAt: null,
    completedAt: null,
    ...overrides,
  } as TaskRun;
}

function resetControllerMocks() {
  mockTaskRunsFindFirst.mockResolvedValue(null);
  mockTaskRunsFindMany.mockResolvedValue([]);
  mockDequeueTaskRun.mockResolvedValue(null);
  mockFindPersistedWorkerBootstrapRestarts.mockResolvedValue([]);
  mockGetOrphanedTaskRun.mockResolvedValue(null);
  mockReadManagedDeploymentAccess.mockResolvedValue({
    state: 'active',
    reason: null,
    revision: 0,
    effectiveAt: '1970-01-01T00:00:00.000Z',
    restrictionStartsAt: null,
    remediationUrl: null,
  });
  mockRecordTaskRunLifecycleEvent.mockResolvedValue(undefined);
  mockRedisSet.mockResolvedValue('OK');
  mockUpdatePendingEnvironmentSnapshot.mockResolvedValue(true);
  mockSyncTaskStateFromRuns.mockResolvedValue(undefined);
  mockDbExecute.mockReset().mockResolvedValue([]);
  mockDbTransaction.mockReset();
  mockUpdateWhere.mockReset().mockReturnValue({
    returning: vi.fn().mockResolvedValue([{}]),
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('BaseController.handleSpawnTaskRunError', () => {
  let controller: TestController;
  const originalCwd = process.cwd();

  beforeEach(() => {
    vi.clearAllMocks();
    resetControllerMocks();
    mockDequeueTaskRun.mockResolvedValue(null);
    mockGetOrphanedTaskRun.mockResolvedValue(null);
    mockOrgsFindFirst.mockResolvedValue({
      id: 'org-1',
      deletedAt: null,
    });
    mockDbTransaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          update: (...args: unknown[]) => mockDbUpdate(...args),
        }),
    );
    controller = new TestController();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    delete process.env.USE_WORKER_RELEASE;
  });

  it('calls finishRun with Failed status and error message', async () => {
    const job = makeTaskRun({ id: 42 });
    const error = new Error('Machine unavailable');

    await expect(
      controller.testHandleSpawnTaskRunError(job, error),
    ).rejects.toThrow('Machine unavailable');

    expect(mockFinishRun).toHaveBeenCalledWith({
      id: 42,
      status: RunStatus.Failed,
      error: 'Machine unavailable',
    });
  });

  it('routes SnapshotEnvironment spawn failures through finishRun, which owns the snapshot pending→failed flip', async () => {
    const attachmentSource = {
      source: 'pending_snapshot_row' as const,
      environmentSnapshotId: '80e3ceee-7d21-491a-96d8-7b0c72b90b4e',
      claimedAt: '2026-05-29T00:00:00.000Z',
    };
    const job = makeTaskRun({
      id: 99,
      payloadKind: TaskPayloadKind.SnapshotEnvironment,
      vendor: 'modal',
      payload: {
        repo: 'owner/repo',
        environmentId: 'env-123',
        environmentSnapshotAttachment: attachmentSource,
      },
    });
    const error = new Error('Snapshot failed');

    await expect(
      controller.testHandleSpawnTaskRunError(job, error),
    ).rejects.toThrow('Snapshot failed');

    expect(mockFinishRun).toHaveBeenCalledWith({
      id: 99,
      status: RunStatus.Failed,
      error: 'Snapshot failed',
    });

    // The environment_snapshots pending→failed transition lives inside
    // finishRun (covered by finish-run.test.ts), not in the controller.
    expect(mockUpdatePendingEnvironmentSnapshot).not.toHaveBeenCalled();
  });

  it('re-throws a sanitized error after calling finishRun (no token-bearing cause)', async () => {
    const job = makeTaskRun();
    const originalError = new Error(
      'Command failed: docker exec -e AUTH_TOKEN=super-secret true',
    );
    Object.assign(originalError, {
      cause: new Error('docker exec -e AUTH_TOKEN=super-secret true'),
    });

    let thrown: unknown;
    try {
      await controller.testHandleSpawnTaskRunError(job, originalError);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBe(originalError);
    expect((thrown as Error).cause).toBeUndefined();
    expect((thrown as Error).message).toContain('AUTH_TOKEN=<redacted>');
    expect((thrown as Error).message).not.toContain('super-secret');

    expect(mockCaptureControllerException).toHaveBeenCalledTimes(1);
    const [capturedError, context] =
      mockCaptureControllerException.mock.calls[0] ?? [];
    expect(capturedError).toBeInstanceOf(Error);
    expect((capturedError as Error).message).not.toContain('super-secret');
    expect((capturedError as Error).cause).toBeUndefined();
    expect(context).toEqual(
      expect.objectContaining({ phase: 'spawn_worker', runId: 42 }),
    );
  });

  it('handles non-Error objects as error messages', async () => {
    const job = makeTaskRun({ id: 7 });

    await expect(
      controller.testHandleSpawnTaskRunError(job, 'string error'),
    ).rejects.toThrow('string error');

    expect(mockFinishRun).toHaveBeenCalledWith({
      id: 7,
      status: RunStatus.Failed,
      error: 'string error',
    });
  });

  it('persists the machine-readable code carried by DockerBootError', async () => {
    const job = makeTaskRun({ id: 11 });
    const error = new DockerBootError(
      TaskRunErrorCode.DockerImageMissing,
      'Docker worker image roomote-worker:local is not available locally and could not be pulled.',
    );

    await expect(
      controller.testHandleSpawnTaskRunError(job, error),
    ).rejects.toThrow('could not be pulled');

    expect(mockFinishRun).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 11,
        status: RunStatus.Failed,
        errorCode: TaskRunErrorCode.DockerImageMissing,
      }),
    );
  });

  it('classifies untyped docker failures from the formatted message', async () => {
    const job = makeTaskRun({ id: 12 });
    const error = new Error(
      'Failed to run docker run.\n\nCannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n\ncommand:\ndocker run -d roomote-worker:local',
    );

    await expect(
      controller.testHandleSpawnTaskRunError(job, error),
    ).rejects.toThrow();

    expect(mockFinishRun).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: TaskRunErrorCode.DockerDaemonUnreachable,
      }),
    );
  });

  it('resolves local release paths from the repo root even when cwd is apps/controller', () => {
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../..',
    );
    process.chdir(path.join(repoRoot, 'apps/controller'));

    const cwdScopedController = new TestController();

    expect(cwdScopedController.getLocalReleasePaths()).toEqual({
      localWorkerReleasePath: path.join(
        repoRoot,
        'releases',
        'worker-vlocal-dev.tar.gz',
      ),
    });
  });

  it('captures a Sentry issue when the controller starts a job from database fallback', async () => {
    const job = makeTaskRun({
      id: 108,
      status: RunStatus.Pending,
      vendor: 'modal',
    });

    mockGetOrphanedTaskRun.mockResolvedValueOnce(job);

    const startPromise = controller.start();

    await vi.waitFor(() => {
      expect(mockCaptureControllerMessage).toHaveBeenCalledWith(
        'Controller started task using database fallback logic',
        expect.objectContaining({
          runId: 108,
          runStatus: RunStatus.Pending,
          payloadKind: TaskPayloadKind.StandardTask,
          phase: 'database_fallback',
          provider: 'modal',
          repo: 'owner/repo',
          source: 'orphaned_task_run_scan',
        }),
        expect.objectContaining({
          component: 'dequeue-loop',
          signal: 'database-fallback-task-start',
        }),
      );
    });

    await controller.stop();
    await startPromise;
  });

  it('does not scan fallback jobs while saturated', async () => {
    const saturatedController = new SaturatedTestController();
    const job = makeTaskRun({
      id: 109,
      status: RunStatus.Pending,
      vendor: 'modal',
    });

    mockGetOrphanedTaskRun.mockResolvedValueOnce(job);

    const startPromise = saturatedController.start();

    await new Promise((resolve) => setTimeout(resolve, 10));

    await saturatedController.stop();
    await startPromise;

    expect(mockGetOrphanedTaskRun).not.toHaveBeenCalled();
    expect(mockCaptureControllerMessage).not.toHaveBeenCalled();
  });
});

describe('BaseController.dequeueTaskRun', () => {
  let controller: TestController;

  beforeEach(() => {
    vi.clearAllMocks();
    resetControllerMocks();
    mockOrgsFindFirst.mockResolvedValue({
      id: 'org-1',
      deletedAt: null,
      slug: 'acme',
    });
    mockDbTransaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          update: (...args: unknown[]) => mockDbUpdate(...args),
        }),
    );
    mockUpdateWhere.mockReturnValue({
      returning: vi.fn().mockResolvedValue([{}]),
    });
    controller = new TestController();
  });

  it('records a controller_dequeue lifecycle event', async () => {
    const job = makeTaskRun({
      id: 77,
      status: RunStatus.Pending,
      vendor: 'modal',
      payload: {
        repo: 'owner/repo',
        environmentId: 'env-1',
      },
    });

    const result = await controller.testDequeueTaskRun(job);

    expect(result).not.toBeNull();
    expect(result?.authToken).toBe('test-token');
    expect(mockRecordTaskRunLifecycleEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 77,
        taskId: 'task-1',
        eventType: 'decision',
        message: expect.stringContaining('Controller dequeued'),
        details: expect.objectContaining({
          stage: 'controller_dequeue',
          status: RunStatus.Dequeued,
          provider: 'modal',
          environmentId: 'env-1',
        }),
      }),
    );
  });

  it('fails pending jobs before token minting when deployment is read-only', async () => {
    const job = makeTaskRun({
      id: 81,
      status: RunStatus.Pending,
    });
    mockReadManagedDeploymentAccess.mockResolvedValueOnce({
      state: 'read_only',
      reason: 'billing_required',
      revision: 7,
      effectiveAt: '2026-07-24T12:00:00.000Z',
      restrictionStartsAt: null,
      remediationUrl: 'https://cloud.roomote.test/#billing',
    });

    const result = await controller.testDequeueTaskRun(job);

    expect(result).toBeNull();
    expect(mockFinishRun).toHaveBeenCalledWith({
      id: 81,
      status: RunStatus.Failed,
      error: 'This deployment is read-only. New task launches are paused.',
      errorCode: TaskRunErrorCode.DeploymentReadOnly,
    });
    expect(mockDbTransaction).not.toHaveBeenCalled();
  });

  it('does not revive a job canceled during the dequeue window', async () => {
    const job = makeTaskRun({
      id: 78,
      status: RunStatus.Pending,
    });

    mockUpdateWhere.mockReturnValueOnce({
      returning: vi.fn().mockResolvedValue([]),
    });
    mockTaskRunsFindFirst.mockResolvedValueOnce({
      status: RunStatus.Canceled,
      canceledAt: new Date(),
    });

    const result = await controller.testDequeueTaskRun(job);

    expect(result).toBeNull();
    expect(mockRecordTaskRunLifecycleEvent).not.toHaveBeenCalled();
  });

  it('treats preparing jobs as recoverable before controller dequeue', async () => {
    const job = makeTaskRun({
      id: 80,
      status: RunStatus.Preparing,
    });

    const result = await controller.testDequeueTaskRun(job);

    expect(result).not.toBeNull();
    expect(result?.authToken).toBe('test-token');
    expect(mockRecordTaskRunLifecycleEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 80,
        details: expect.objectContaining({
          stage: 'controller_dequeue',
          status: RunStatus.Dequeued,
        }),
      }),
    );
  });

  it('treats an already-advanced dequeue race as a no-op', async () => {
    const job = makeTaskRun({
      id: 79,
      status: RunStatus.Pending,
    });

    mockUpdateWhere.mockReturnValueOnce({
      returning: vi.fn().mockResolvedValue([]),
    });
    mockTaskRunsFindFirst.mockResolvedValueOnce({
      status: RunStatus.Dequeued,
      canceledAt: null,
    });

    const result = await controller.testDequeueTaskRun(job);

    expect(result).toBeNull();
    expect(mockRecordTaskRunLifecycleEvent).not.toHaveBeenCalled();
  });
});

describe('BaseController.handleWorkerExitBeforeStart', () => {
  let controller: TestController;

  beforeEach(() => {
    vi.clearAllMocks();
    resetControllerMocks();
    mockUpdateWhere.mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 42 }]),
    });
    mockDbTransaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          execute: (...args: unknown[]) => mockDbExecute(...args),
          update: (...args: unknown[]) => mockDbUpdate(...args),
        }),
    );
    controller = new TestController();
  });

  it('schedules one fresh sandbox when the first worker exits before starting', async () => {
    mockDbExecute.mockResolvedValueOnce([{ id: 42 }]).mockResolvedValueOnce([]);
    const job = makeTaskRun({
      id: 42,
      status: RunStatus.Dequeued,
      machineId: 'sandbox-old',
      startedAt: null,
      workerHeartbeatAt: null,
    });

    await expect(
      controller.testHandleWorkerExitBeforeStart(job, 1),
    ).resolves.toBe('restart');

    expect(mockDbUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: RunStatus.Pending,
        machineId: null,
        provisionStartedAt: null,
        provisionReadyAt: null,
      }),
    );
    expect(mockFinishRun).not.toHaveBeenCalled();
    expect(mockRecordTaskRunLifecycleEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 42,
        details: expect.objectContaining({
          stage: 'worker_bootstrap_restart',
          restartAttempt: 1,
          previousMachineId: 'sandbox-old',
        }),
      }),
    );
    expect(mockCaptureControllerMessage).toHaveBeenCalledWith(
      'Controller scheduled a fresh sandbox after worker bootstrap failure',
      expect.objectContaining({
        runId: 42,
        exitCode: 1,
        restartAttempt: 1,
        phase: 'worker_bootstrap',
      }),
      expect.objectContaining({ signal: 'worker-bootstrap-restart' }),
    );
  });

  it('fails the run when the replacement worker also exits before starting', async () => {
    mockDbExecute
      .mockResolvedValueOnce([{ id: 42 }])
      .mockResolvedValueOnce([{ id: 'restart-event' }]);

    await expect(
      controller.testHandleWorkerExitBeforeStart(
        makeTaskRun({ id: 42, status: RunStatus.Dequeued }),
        1,
      ),
    ).resolves.toBe('failed');

    expect(mockFinishRun).toHaveBeenCalledWith({
      id: 42,
      status: RunStatus.Failed,
      error: 'Worker process exited before claiming task run (exit code 1)',
    });
  });

  it('persists launch diagnostics on the run when the bootstrap failure is finalized', async () => {
    mockDbExecute
      .mockResolvedValueOnce([{ id: 42 }])
      .mockResolvedValueOnce([{ id: 'restart-event' }]);

    await expect(
      controller.testHandleWorkerExitBeforeStart(
        makeTaskRun({ id: 42, status: RunStatus.Dequeued }),
        1,
        'probe "worker --version" exited with code 1; probe stderr: Error: WORKER_API_URL is required',
      ),
    ).resolves.toBe('failed');

    const expectedError =
      'Worker process exited before claiming task run (exit code 1); ' +
      'probe "worker --version" exited with code 1; probe stderr: Error: WORKER_API_URL is required';

    // The diagnostics reach both the durable run write and finishRun.
    expect(mockDbUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: RunStatus.Failed,
        error: expectedError,
      }),
    );
    expect(mockFinishRun).toHaveBeenCalledWith({
      id: 42,
      status: RunStatus.Failed,
      error: expectedError,
    });
  });

  it('records launch diagnostics on the bootstrap restart decision event', async () => {
    mockDbExecute.mockResolvedValueOnce([{ id: 42 }]).mockResolvedValueOnce([]);

    await expect(
      controller.testHandleWorkerExitBeforeStart(
        makeTaskRun({
          id: 42,
          status: RunStatus.Dequeued,
          machineId: 'sandbox-old',
          startedAt: null,
          workerHeartbeatAt: null,
        }),
        1,
        'stderr: worker failed before claim',
      ),
    ).resolves.toBe('restart');

    expect(mockRecordTaskRunLifecycleEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({
          stage: 'worker_bootstrap_restart',
          launchDiagnostics: 'stderr: worker failed before claim',
        }),
      }),
    );
  });

  it('ignores an exit when the run already advanced', async () => {
    mockUpdateWhere.mockReturnValueOnce({
      returning: vi.fn().mockResolvedValue([]),
    });

    const claimed = await controller.testHandleWorkerExitBeforeStart(
      makeTaskRun({ id: 42, status: RunStatus.Processing }),
      0,
    );

    expect(claimed).toBe('ignore');
    expect(mockFinishRun).not.toHaveBeenCalled();
    expect(mockCaptureControllerMessage).not.toHaveBeenCalled();
  });

  it('fails every provisioned run due in the same watchdog scan', async () => {
    mockTaskRunsFindMany.mockResolvedValueOnce([
      makeTaskRun({
        id: 43,
        status: RunStatus.Dequeued,
        provisionReadyAt: new Date(Date.now() - 3 * 60_000),
        startedAt: null,
        workerHeartbeatAt: null,
      }),
      makeTaskRun({
        id: 45,
        status: RunStatus.Dequeued,
        provisionReadyAt: new Date(Date.now() - 4 * 60_000),
        startedAt: null,
        workerHeartbeatAt: null,
      }),
    ]);

    await expect(controller.testFailTimedOutWorkerBootstraps()).resolves.toBe(
      2,
    );

    expect(mockFinishRun).toHaveBeenCalledTimes(2);
    expect(mockFinishRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: 43, status: RunStatus.Failed }),
    );
    expect(mockFinishRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: 45, status: RunStatus.Failed }),
    );
    expect(mockSyncTaskStateFromRuns).toHaveBeenCalledTimes(2);
  });

  it('fails a dequeued run abandoned before its environment ever became ready', async () => {
    // The provisioned sweep finds nothing; the abandoned sweep claims the run
    // whose sandbox died before the worker could ever start it (2026-08-14
    // staging incident, runs #4616/#4617).
    mockTaskRunsFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      makeTaskRun({
        id: 4616,
        status: RunStatus.Dequeued,
        dequeuedAt: new Date(Date.now() - 24 * 60 * 60_000),
        provisionReadyAt: null,
        startedAt: null,
        workerHeartbeatAt: null,
      }),
    ]);

    await expect(controller.testFailTimedOutWorkerBootstraps()).resolves.toBe(
      1,
    );

    expect(mockFinishRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: 4616, status: RunStatus.Failed }),
    );
    expect(mockCaptureControllerMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ runId: 4616 }),
      expect.objectContaining({ signal: 'worker-bootstrap-abandoned' }),
    );
  });

  it('recovers every persisted bootstrap restart after controller state is lost', async () => {
    mockFindPersistedWorkerBootstrapRestarts.mockResolvedValueOnce([
      makeTaskRun({ id: 46, status: RunStatus.Pending }),
      makeTaskRun({ id: 47, status: RunStatus.Pending }),
    ]);

    await expect(
      controller.testRecoverPersistedWorkerBootstrapRestarts(),
    ).resolves.toBe(2);
  });

  it('keeps the claimed failure durable when finalization side effects fail', async () => {
    mockDbExecute
      .mockResolvedValueOnce([{ id: 44 }])
      .mockResolvedValueOnce([{ id: 'restart-event' }]);
    mockFinishRun.mockRejectedValueOnce(new Error('notification failed'));

    await expect(
      controller.testHandleWorkerExitBeforeStart(
        makeTaskRun({ id: 44, status: RunStatus.Dequeued }),
        1,
      ),
    ).resolves.toBe('failed');

    expect(mockCaptureControllerException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'notification failed' }),
      expect.objectContaining({
        runId: 44,
        phase: 'worker_bootstrap_finalize',
      }),
    );
    expect(mockSyncTaskStateFromRuns).toHaveBeenCalledWith(
      expect.anything(),
      'task-1',
    );
    expect(mockSyncTaskStateFromRuns.mock.invocationCallOrder[0]).toBeLessThan(
      mockFinishRun.mock.invocationCallOrder[0] ?? Infinity,
    );
  });
});
