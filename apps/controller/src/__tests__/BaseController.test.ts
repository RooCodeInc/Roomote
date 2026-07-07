import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CloudTaskStatus, CloudTaskType } from '@roomote/types';
import type { CloudJob } from '@roomote/db/server';

// ── Mocks ────────────────────────────────────────────────────────────────────

const {
  mockFinishCloudJob,
  mockCaptureControllerException,
  mockCaptureControllerMessage,
  mockCloudJobsFindFirst,
  mockOrgsFindFirst,
  mockDequeueCloudTask,
  mockResolveUserIdForCloudJob,
  mockGetOrphanedJob,
  mockRecordJobLifecycleEvent,
  mockRedisSet,
  mockUpdateWhere,
} = vi.hoisted(() => ({
  mockFinishCloudJob: vi.fn().mockResolvedValue(undefined),
  mockCaptureControllerException: vi.fn(),
  mockCaptureControllerMessage: vi.fn(),
  mockCloudJobsFindFirst: vi.fn(),
  mockOrgsFindFirst: vi.fn(),
  mockDequeueCloudTask: vi.fn().mockResolvedValue(null),
  mockResolveUserIdForCloudJob: vi.fn().mockResolvedValue('user-1'),
  mockGetOrphanedJob: vi.fn().mockResolvedValue(null),
  mockRecordJobLifecycleEvent: vi.fn().mockResolvedValue(undefined),
  mockRedisSet: vi.fn().mockResolvedValue('OK'),
  mockUpdateWhere: vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue([{}]),
  }),
}));

vi.mock('@roomote/sdk/server', () => ({
  finishCloudJob: (...args: unknown[]) => mockFinishCloudJob(...args),
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
        cloudJobs: {
          findFirst: (...args: unknown[]) => mockCloudJobsFindFirst(...args),
        },
        orgs: { findFirst: (...args: unknown[]) => mockOrgsFindFirst(...args) },
      },
      insert: (...args: unknown[]) => mockDbInsert(...args),
      transaction: (...args: unknown[]) => mockDbTransaction(...args),
      update: (...args: unknown[]) => mockDbUpdate(...args),
      execute: (...args: unknown[]) => mockDbExecute(...args),
    },
    recordJobLifecycleEvent: (...args: unknown[]) =>
      mockRecordJobLifecycleEvent(...args),
    updatePendingEnvironmentSnapshot: (...args: unknown[]) =>
      mockUpdatePendingEnvironmentSnapshot(...args),
  };
});

vi.mock('@roomote/auth', () => ({
  createJobToken: vi.fn().mockResolvedValue('test-token'),
}));

vi.mock('@roomote/redis', () => ({
  getRedis: vi.fn().mockReturnValue({
    set: (...args: unknown[]) => mockRedisSet(...args),
  }),
  REDIS_KEYS: { CONTROLLER_HEARTBEAT: 'controller:heartbeat' },
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  dequeueCloudTask: (...args: unknown[]) => mockDequeueCloudTask(...args),
  resolveUserIdForCloudJob: (...args: unknown[]) =>
    mockResolveUserIdForCloudJob(...args),
}));

vi.mock('../orphaned-cloud-jobs', () => ({
  getOrphanedJob: (...args: unknown[]) => mockGetOrphanedJob(...args),
}));

vi.mock('../monitoring/sentry', () => ({
  captureControllerException: (...args: unknown[]) =>
    mockCaptureControllerException(...args),
  captureControllerMessage: (...args: unknown[]) =>
    mockCaptureControllerMessage(...args),
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import { BaseController } from '../BaseController';

// Create a concrete subclass for testing the abstract BaseController.
class TestController extends BaseController {
  constructor() {
    super('development');
  }

  protected async spawnFreshWorker(
    _cloudJob: CloudJob,
    _authToken: string,
    _deploymentSlug: string,
    _sandboxTimeoutMs: number,
  ): Promise<void> {
    // no-op for testing
  }

  // Expose handleSpawnJobError for direct testing.
  public async testHandleSpawnJobError(
    cloudJob: CloudJob,
    error: unknown,
  ): Promise<void> {
    return this.handleSpawnJobError(cloudJob, error);
  }

  public getLocalReleasePaths() {
    return {
      localWorkerReleasePath: this.localWorkerReleasePath,
    };
  }

  public async testDequeueCloudJob(cloudJob: CloudJob) {
    return this.dequeueCloudJob(cloudJob);
  }
}

class SaturatedTestController extends TestController {
  protected readonly MAX_CONCURRENT_SPAWNS: number = 0;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCloudJob(overrides: Partial<CloudJob> = {}): CloudJob {
  return {
    id: 42,
    type: CloudTaskType.StandardTask,
    userId: 'user-1',
    harness: 'opencode-server',
    status: CloudTaskStatus.Running,
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
  } as CloudJob;
}

function resetControllerMocks() {
  mockCloudJobsFindFirst.mockResolvedValue(null);
  mockDequeueCloudTask.mockResolvedValue(null);
  mockGetOrphanedJob.mockResolvedValue(null);
  mockRecordJobLifecycleEvent.mockResolvedValue(undefined);
  mockRedisSet.mockResolvedValue('OK');
  mockUpdatePendingEnvironmentSnapshot.mockResolvedValue(true);
  mockUpdateWhere.mockReturnValue({
    returning: vi.fn().mockResolvedValue([{}]),
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('BaseController.handleSpawnJobError', () => {
  let controller: TestController;
  const originalCwd = process.cwd();

  beforeEach(() => {
    vi.clearAllMocks();
    resetControllerMocks();
    mockDequeueCloudTask.mockResolvedValue(null);
    mockResolveUserIdForCloudJob.mockResolvedValue('user-1');
    mockGetOrphanedJob.mockResolvedValue(null);
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

  it('calls finishCloudJob with Failed status and error message', async () => {
    const job = makeCloudJob({ id: 42 });
    const error = new Error('Machine unavailable');

    await expect(
      controller.testHandleSpawnJobError(job, error),
    ).rejects.toThrow('Machine unavailable');

    expect(mockFinishCloudJob).toHaveBeenCalledWith({
      id: 42,
      status: CloudTaskStatus.Failed,
      error: 'Machine unavailable',
    });
  });

  it('marks pending snapshots as failed when job is SnapshotEnvironment', async () => {
    const attachmentSource = {
      source: 'pending_snapshot_row' as const,
      environmentSnapshotId: '80e3ceee-7d21-491a-96d8-7b0c72b90b4e',
      claimedAt: '2026-05-29T00:00:00.000Z',
    };
    const job = makeCloudJob({
      id: 99,
      type: CloudTaskType.SnapshotEnvironment,
      vendor: 'modal',
      payload: {
        repo: 'owner/repo',
        environmentId: 'env-123',
        environmentSnapshotAttachment: attachmentSource,
      },
    });
    const error = new Error('Snapshot failed');

    await expect(
      controller.testHandleSpawnJobError(job, error),
    ).rejects.toThrow('Snapshot failed');

    expect(mockFinishCloudJob).toHaveBeenCalledWith({
      id: 99,
      status: CloudTaskStatus.Failed,
      error: 'Snapshot failed',
    });

    expect(mockUpdatePendingEnvironmentSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        environmentId: 'env-123',
        provider: 'modal',
        snapshotId: null,
        snapshotStatus: 'failed',
        snapshotCreatedAt: null,
        snapshotExpiresAt: null,
        attachmentSource,
        maxPendingUpdatedAt: null,
      }),
    );
  });

  it('re-throws the original error after calling finishCloudJob', async () => {
    const job = makeCloudJob();
    const originalError = new Error('original');

    await expect(
      controller.testHandleSpawnJobError(job, originalError),
    ).rejects.toThrow('original');
  });

  it('handles non-Error objects as error messages', async () => {
    const job = makeCloudJob({ id: 7 });

    await expect(
      controller.testHandleSpawnJobError(job, 'string error'),
    ).rejects.toBe('string error');

    expect(mockFinishCloudJob).toHaveBeenCalledWith({
      id: 7,
      status: CloudTaskStatus.Failed,
      error: 'string error',
    });
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
    const job = makeCloudJob({
      id: 108,
      status: CloudTaskStatus.Pending,
      vendor: 'modal',
    });

    mockGetOrphanedJob.mockResolvedValueOnce(job);

    const startPromise = controller.start();

    await vi.waitFor(() => {
      expect(mockCaptureControllerMessage).toHaveBeenCalledWith(
        'Controller started task using database fallback logic',
        expect.objectContaining({
          jobId: 108,
          jobStatus: CloudTaskStatus.Pending,
          jobType: CloudTaskType.StandardTask,
          phase: 'database_fallback',
          provider: 'modal',
          repo: 'owner/repo',
          source: 'orphaned_job_scan',
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
    const job = makeCloudJob({
      id: 109,
      status: CloudTaskStatus.Pending,
      vendor: 'modal',
    });

    mockGetOrphanedJob.mockResolvedValueOnce(job);

    const startPromise = saturatedController.start();

    await new Promise((resolve) => setTimeout(resolve, 10));

    await saturatedController.stop();
    await startPromise;

    expect(mockGetOrphanedJob).not.toHaveBeenCalled();
    expect(mockCaptureControllerMessage).not.toHaveBeenCalled();
  });
});

describe('BaseController.dequeueCloudJob', () => {
  let controller: TestController;

  beforeEach(() => {
    vi.clearAllMocks();
    resetControllerMocks();
    mockResolveUserIdForCloudJob.mockResolvedValue('user-1');
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
    const job = makeCloudJob({
      id: 77,
      status: CloudTaskStatus.Pending,
      vendor: 'modal',
      payload: {
        repo: 'owner/repo',
        environmentId: 'env-1',
      },
    });

    const result = await controller.testDequeueCloudJob(job);

    expect(result).not.toBeNull();
    expect(result?.authToken).toBe('test-token');
    expect(mockRecordJobLifecycleEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        cloudJobId: 77,
        taskId: 'task-1',
        eventType: 'decision',
        message: expect.stringContaining('Controller dequeued'),
        details: expect.objectContaining({
          stage: 'controller_dequeue',
          status: CloudTaskStatus.Dequeued,
          provider: 'modal',
          environmentId: 'env-1',
        }),
      }),
    );
  });

  it('does not revive a job canceled during the dequeue window', async () => {
    const job = makeCloudJob({
      id: 78,
      status: CloudTaskStatus.Pending,
    });

    mockUpdateWhere.mockReturnValueOnce({
      returning: vi.fn().mockResolvedValue([]),
    });
    mockCloudJobsFindFirst.mockResolvedValueOnce({
      status: CloudTaskStatus.Canceled,
      canceledAt: new Date(),
    });

    const result = await controller.testDequeueCloudJob(job);

    expect(result).toBeNull();
    expect(mockRecordJobLifecycleEvent).not.toHaveBeenCalled();
  });

  it('treats preparing jobs as recoverable before controller dequeue', async () => {
    const job = makeCloudJob({
      id: 80,
      status: CloudTaskStatus.Preparing,
    });

    const result = await controller.testDequeueCloudJob(job);

    expect(result).not.toBeNull();
    expect(result?.authToken).toBe('test-token');
    expect(mockRecordJobLifecycleEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        cloudJobId: 80,
        details: expect.objectContaining({
          stage: 'controller_dequeue',
          status: CloudTaskStatus.Dequeued,
        }),
      }),
    );
  });

  it('treats an already-advanced dequeue race as a no-op', async () => {
    const job = makeCloudJob({
      id: 79,
      status: CloudTaskStatus.Pending,
    });

    mockUpdateWhere.mockReturnValueOnce({
      returning: vi.fn().mockResolvedValue([]),
    });
    mockCloudJobsFindFirst.mockResolvedValueOnce({
      status: CloudTaskStatus.Dequeued,
      canceledAt: null,
    });

    const result = await controller.testDequeueCloudJob(job);

    expect(result).toBeNull();
    expect(mockRecordJobLifecycleEvent).not.toHaveBeenCalled();
  });
});
