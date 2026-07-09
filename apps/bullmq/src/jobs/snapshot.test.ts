import { UnrecoverableError } from 'bullmq';
import type { Mock } from 'vitest';

import {
  CloudTaskStatus,
  TaskPayloadKind,
  withCompleteTaskOnSnapshot,
} from '@roomote/types';

const {
  mockFindFirst,
  mockTaskFindFirst,
  mockGetInstanceStatus,
  mockCreateSnapshot,
  mockFindSnapshotBySourceInstance,
  mockRecordMutation,
  mockCreateComputeProviderMutationEventRecorder,
  mockRecordCloudJobEvent,
  mockUpdatePendingEnvironmentSnapshot,
  mockAttachEnvironmentSnapshot,
  mockCaptureBullMqMessage,
  mockDrainLinearMessagesToResumeJob,
  mockDrainSlackMessagesToResumeJob,
  mockRecordComputeProviderUsage,
  mockMarkTaskStartParallelCountEndedAt,
  transactionFn,
  andFn,
  eqFn,
  isNullFn,
  updateWhereFn,
  setFn,
  updateFn,
} = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnyMock = Mock<(...args: any[]) => any>;

  const andFn: AnyMock = vi.fn(() => 'and-condition');
  const eqFn: AnyMock = vi.fn(() => 'eq-condition');
  const isNullFn: AnyMock = vi.fn(() => 'is-null-condition');
  const updateWhereFn: AnyMock = vi.fn(() => Promise.resolve([]));
  const setFn: AnyMock = vi.fn(() => ({ where: updateWhereFn }));
  const updateFn: AnyMock = vi.fn(() => ({ set: setFn }));

  return {
    mockFindFirst: vi.fn() as AnyMock,
    mockTaskFindFirst: vi.fn() as AnyMock,
    mockGetInstanceStatus: vi.fn() as AnyMock,
    mockCreateSnapshot: vi.fn() as AnyMock,
    mockFindSnapshotBySourceInstance: vi.fn() as AnyMock,
    mockRecordMutation: vi.fn() as AnyMock,
    mockCreateComputeProviderMutationEventRecorder: vi.fn() as AnyMock,
    mockRecordCloudJobEvent: vi.fn() as AnyMock,
    mockUpdatePendingEnvironmentSnapshot: vi.fn() as AnyMock,
    mockAttachEnvironmentSnapshot: vi.fn() as AnyMock,
    mockCaptureBullMqMessage: vi.fn() as AnyMock,
    mockDrainLinearMessagesToResumeJob: vi.fn() as AnyMock,
    mockDrainSlackMessagesToResumeJob: vi.fn() as AnyMock,
    mockRecordComputeProviderUsage: vi.fn() as AnyMock,
    mockMarkTaskStartParallelCountEndedAt: vi.fn() as AnyMock,
    transactionFn: vi.fn() as AnyMock,
    andFn,
    eqFn,
    isNullFn,
    updateWhereFn,
    setFn,
    updateFn,
  };
});

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: {
        findFirst: mockFindFirst,
      },
      tasks: {
        findFirst: mockTaskFindFirst,
      },
    },
    transaction: transactionFn,
    update: updateFn,
  },
  taskRuns: {
    id: 'id',
    snapshotId: 'snapshotId',
  },
  tasks: {
    id: 'task-id',
  },
  and: andFn,
  eq: eqFn,
  isNull: isNullFn,
  createComputeProviderMutationEventRecorder:
    mockCreateComputeProviderMutationEventRecorder,
  markTaskStartParallelCountEndedAt: mockMarkTaskStartParallelCountEndedAt,
  recordCloudJobEvent: mockRecordCloudJobEvent,
  resolveComputeProviderEnvValues: vi.fn().mockResolvedValue({}),
  updatePendingEnvironmentSnapshot: mockUpdatePendingEnvironmentSnapshot,
  attachEnvironmentSnapshot: mockAttachEnvironmentSnapshot,
  getEnvironmentSnapshotAttachmentSourceForCloudJob: (cloudJob: {
    payload: { environmentSnapshotAttachment?: { source?: string } | null };
  }) =>
    'environmentSnapshotAttachment' in cloudJob.payload
      ? (cloudJob.payload.environmentSnapshotAttachment ?? null)
      : null,
  buildPendingEnvironmentSnapshotMatchForCloudJob: (cloudJob: {
    payload: { environmentSnapshotAttachment?: { source?: string } | null };
    createdAt?: Date;
  }) => {
    const attachmentSource =
      'environmentSnapshotAttachment' in cloudJob.payload
        ? (cloudJob.payload.environmentSnapshotAttachment ?? null)
        : null;

    if (attachmentSource?.source === 'pending_snapshot_row') {
      return { attachmentSource, maxPendingUpdatedAt: null };
    }

    return {
      attachmentSource: null,
      maxPendingUpdatedAt: cloudJob.createdAt,
    };
  },
}));

vi.mock('@roomote/compute-providers', () => ({
  createComputeProviderClient: () => ({
    vendor: 'modal',
    getInstanceStatus: mockGetInstanceStatus,
    createSnapshot: mockCreateSnapshot,
    findSnapshotBySourceInstance: mockFindSnapshotBySourceInstance,
  }),
}));

vi.mock('@roomote/linear', () => ({
  drainLinearMessagesToResumeJob: mockDrainLinearMessagesToResumeJob,
}));

vi.mock('@roomote/slack', () => ({
  drainSlackMessagesToResumeJob: mockDrainSlackMessagesToResumeJob,
}));

vi.mock('@roomote/sdk/server', () => ({
  recordComputeProviderUsage: mockRecordComputeProviderUsage,
}));

vi.mock('../monitoring/sentry', () => ({
  captureBullMqMessage: mockCaptureBullMqMessage,
}));

import { snapshotJob } from './snapshot';

const baseCloudJob = {
  id: 123,
  taskId: 'task_snapshot_events',
  vendor: 'modal',
  status: CloudTaskStatus.Idle,
  taskPhase: 'waiting_for_prompt',
  sleepAt: new Date('2026-04-02T21:34:02.798Z'),
  payload: { environmentId: 'env-1' },
  payloadKind: TaskPayloadKind.SnapshotEnvironment,
  actingUserId: null,
  port: null,
  createdAt: new Date('2026-04-24T06:35:00.000Z'),
};

describe('snapshotJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateComputeProviderMutationEventRecorder.mockReturnValue(
      mockRecordMutation,
    );
    transactionFn.mockImplementation(async (callback) =>
      callback({
        update: updateFn,
      }),
    );
    updateFn.mockReturnValue({ set: setFn });
    setFn.mockReturnValue({ where: updateWhereFn });
    updateWhereFn.mockResolvedValue([]);
    mockMarkTaskStartParallelCountEndedAt.mockResolvedValue(undefined);
    mockUpdatePendingEnvironmentSnapshot.mockResolvedValue(true);
    mockAttachEnvironmentSnapshot.mockResolvedValue(true);
    mockFindFirst.mockResolvedValue(baseCloudJob);
    mockTaskFindFirst.mockResolvedValue({
      slackThreadTs: null,
      linearSessionId: null,
      linearIssueId: null,
      linearOrganizationId: null,
    });
    mockFindSnapshotBySourceInstance.mockResolvedValue(null);
    mockDrainLinearMessagesToResumeJob.mockResolvedValue({ resumed: false });
    mockDrainSlackMessagesToResumeJob.mockResolvedValue({ resumed: false });
  });

  it('records durable started/completed events when a snapshot succeeds', async () => {
    mockGetInstanceStatus.mockResolvedValue({ status: 'running' });
    mockCreateSnapshot.mockResolvedValue({
      snapshotId: 'snap_success_1',
      usageObservation: {
        activeCpuDurationMs: 12_345,
        networkTransfer: {
          ingress: 200,
          egress: 300,
        },
      },
    });

    await snapshotJob({
      data: { cloudJobId: 123, sandboxId: 'sb-success' },
    } as never);

    expect(mockRecordCloudJobEvent).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        runId: 123,
        source: 'snapshot_queue',
        eventType: 'started',
      }),
    );
    expect(mockRecordCloudJobEvent).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        runId: 123,
        source: 'snapshot_queue',
        eventType: 'decision',
        details: expect.objectContaining({
          decision: 'pre_snapshot_instance_status_observed',
          instanceStatus: 'running',
        }),
      }),
    );
    expect(mockRecordCloudJobEvent).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      expect.objectContaining({
        runId: 123,
        source: 'snapshot_queue',
        eventType: 'completed',
        details: expect.objectContaining({ snapshotId: 'snap_success_1' }),
      }),
    );
    expect(mockAttachEnvironmentSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        environmentId: 'env-1',
        provider: 'modal',
        snapshotId: 'snap_success_1',
        snapshotStatus: 'ready',
      }),
    );
    expect(mockCreateComputeProviderMutationEventRecorder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 123,
        taskId: 'task_snapshot_events',
      }),
      expect.anything(),
    );
    expect(mockRecordMutation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        provider: 'modal',
        operation: 'create_snapshot',
        eventType: 'started',
        instanceId: 'sb-success',
      }),
    );
    expect(mockRecordMutation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        provider: 'modal',
        operation: 'create_snapshot',
        eventType: 'completed',
        instanceId: 'sb-success',
      }),
    );
    expect(setFn).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshotId: 'snap_success_1',
        snapshotFailedAt: null,
        status: CloudTaskStatus.Completed,
      }),
    );
    expect(mockRecordComputeProviderUsage).toHaveBeenCalledWith({
      cloudJobId: 123,
      lifecycleAction: 'snapshot',
      completedAt: expect.any(Date),
      activeCpuDurationMs: 12_345,
      networkIngressBytes: 200,
      networkEgressBytes: 300,
      details: {
        provider: 'modal',
        snapshotId: 'snap_success_1',
        source: 'snapshot_queue',
      },
    });
  });

  it('marks the linked task completed when requested by completion-on-snapshot metadata', async () => {
    mockFindFirst.mockResolvedValue({
      ...baseCloudJob,
      payloadKind: TaskPayloadKind.StandardTask,
      payload: withCompleteTaskOnSnapshot({
        repo: 'acme/task-repo',
        description: 'Queue-driven task',
      }),
    });
    mockGetInstanceStatus.mockResolvedValue({ status: 'running' });
    mockCreateSnapshot.mockResolvedValue({
      snapshotId: 'snap_mark_done',
    });

    await snapshotJob({
      data: { cloudJobId: 123, sandboxId: 'sb-mark-done' },
    } as never);

    expect(updateFn).toHaveBeenCalledWith({ id: 'task-id' });
    expect(setFn).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'completed',
        updatedAt: expect.any(Date),
      }),
    );
  });

  it('does not reattach a snapshot when the snapshot attachment is stale', async () => {
    mockGetInstanceStatus.mockResolvedValue({ status: 'running' });
    mockCreateSnapshot.mockResolvedValue({
      snapshotId: 'snap_stale_after_edit',
    });
    mockAttachEnvironmentSnapshot.mockResolvedValue(false);

    await snapshotJob({
      data: { cloudJobId: 123, sandboxId: 'sb-stale-after-edit' },
    } as never);

    expect(mockAttachEnvironmentSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        environmentId: 'env-1',
        snapshotId: 'snap_stale_after_edit',
      }),
    );
    expect(mockRecordCloudJobEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 123,
        source: 'snapshot_queue',
        eventType: 'decision',
        details: expect.objectContaining({
          decision: 'skip_attach_stale_environment_snapshot',
          environmentId: 'env-1',
          snapshotId: 'snap_stale_after_edit',
          attachmentSource: 'pending_snapshot_row',
        }),
      }),
    );
    expect(setFn).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshotId: 'snap_stale_after_edit',
        snapshotFailedAt: null,
        status: CloudTaskStatus.Completed,
      }),
    );
  });

  it('uses the pending snapshot claim identity when attaching a completed snapshot', async () => {
    const attachmentSource = {
      source: 'pending_snapshot_row' as const,
      environmentSnapshotId: '80e3ceee-7d21-491a-96d8-7b0c72b90b4e',
      claimedAt: '2026-05-29T00:00:00.000Z',
    };
    mockFindFirst.mockResolvedValue({
      ...baseCloudJob,
      payload: {
        environmentId: 'env-1',
        environmentSnapshotAttachment: attachmentSource,
      },
    });
    mockGetInstanceStatus.mockResolvedValue({ status: 'running' });
    mockCreateSnapshot.mockResolvedValue({
      snapshotId: 'snap_claim_owned',
    });

    await snapshotJob({
      data: { cloudJobId: 123, sandboxId: 'sb-claim-owned' },
    } as never);

    expect(mockAttachEnvironmentSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        environmentId: 'env-1',
        snapshotId: 'snap_claim_owned',
        attachmentSource,
        maxPendingUpdatedAt: null,
      }),
    );
  });

  it('records a durable failure event when the sandbox is already stopped', async () => {
    mockGetInstanceStatus.mockResolvedValue({ status: 'stopped' });

    await expect(
      snapshotJob({
        data: { cloudJobId: 123, sandboxId: 'sb-stopped' },
      } as never),
    ).rejects.toThrow('Instance is not running');

    expect(mockRecordCloudJobEvent).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({
        runId: 123,
        source: 'snapshot_queue',
        eventType: 'started',
      }),
    );
    expect(mockRecordCloudJobEvent).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        runId: 123,
        source: 'snapshot_queue',
        eventType: 'decision',
        details: expect.objectContaining({
          decision: 'pre_snapshot_instance_status_observed',
          instanceStatus: 'stopped',
        }),
      }),
    );
    expect(mockRecordCloudJobEvent).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      expect.objectContaining({
        runId: 123,
        source: 'snapshot_queue',
        eventType: 'failed',
        details: expect.objectContaining({ instanceStatus: 'stopped' }),
      }),
    );
    expect(setFn).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshotRequestedAt: null,
        sleepRequestedAt: null,
        error: 'Cannot create snapshot: instance is stopped',
      }),
    );
    expect(eqFn).toHaveBeenCalledWith('id', 123);
    expect(isNullFn).toHaveBeenCalledWith('snapshotId');
    expect(andFn).toHaveBeenCalledWith('eq-condition', 'is-null-condition');
    expect(updateWhereFn).toHaveBeenCalledWith('and-condition');
    expect(mockUpdatePendingEnvironmentSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        environmentId: 'env-1',
        provider: 'modal',
        snapshotStatus: 'failed',
      }),
    );
    expect(mockRecordMutation).not.toHaveBeenCalled();
  });

  it('guards the failure update when createSnapshot throws after the job started', async () => {
    mockGetInstanceStatus.mockResolvedValue({ status: 'running' });
    mockCreateSnapshot.mockRejectedValue(
      Object.assign(new Error('Status code 422 is not ok'), {
        response: new Response(
          '{"error":"sandbox cannot snapshot right now"}',
          {
            status: 422,
            statusText: 'Unprocessable Entity',
            headers: {
              'content-type': 'application/json',
              'x-vercel-request-id': 'req_123',
            },
          },
        ),
        text: '{"error":"sandbox cannot snapshot right now"}',
        json: { error: 'sandbox cannot snapshot right now' },
        sandboxId: 'sb-running',
        context: {
          instanceId: 'sb-running',
          instanceStatusAfterError: 'snapshotting',
        },
      }),
    );

    await expect(
      snapshotJob({
        data: { cloudJobId: 123, sandboxId: 'sb-running' },
      } as never),
    ).rejects.toThrow('Status code 422 is not ok');

    expect(setFn).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshotRequestedAt: null,
        sleepRequestedAt: null,
        error: 'Snapshot failed: Status code 422 is not ok',
      }),
    );
    expect(eqFn).toHaveBeenCalledWith('id', 123);
    expect(isNullFn).toHaveBeenCalledWith('snapshotId');
    expect(andFn).toHaveBeenCalledWith('eq-condition', 'is-null-condition');
    expect(updateWhereFn).toHaveBeenCalledWith('and-condition');
    expect(mockUpdatePendingEnvironmentSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        environmentId: 'env-1',
        provider: 'modal',
        snapshotStatus: 'failed',
      }),
    );
    expect(mockRecordMutation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        provider: 'modal',
        operation: 'create_snapshot',
        eventType: 'failed',
        instanceId: 'sb-running',
        details: expect.objectContaining({
          error: 'Status code 422 is not ok',
          errorDetails: expect.objectContaining({
            responseStatus: 422,
            responseStatusText: 'Unprocessable Entity',
            responseText: '{"error":"sandbox cannot snapshot right now"}',
            responseJson: {
              error: 'sandbox cannot snapshot right now',
            },
            sandboxId: 'sb-running',
            context: {
              instanceId: 'sb-running',
              instanceStatusAfterError: 'snapshotting',
            },
          }),
        }),
      }),
    );
    expect(mockRecordCloudJobEvent).toHaveBeenNthCalledWith(
      4,
      expect.anything(),
      expect.objectContaining({
        runId: 123,
        source: 'snapshot_queue',
        eventType: 'failed',
        details: expect.objectContaining({
          error: 'Status code 422 is not ok',
          errorDetails: expect.objectContaining({
            responseStatus: 422,
            sandboxId: 'sb-running',
          }),
        }),
      }),
    );
    expect(mockCaptureBullMqMessage).toHaveBeenCalledWith(
      'Snapshot creation failed',
      expect.objectContaining({
        cloudJobId: 123,
        taskId: 'task_snapshot_events',
        computeProvider: 'modal',
        providerErrorMessage: 'sandbox cannot snapshot right now',
        providerRequestId: 'req_123',
        providerResponseStatus: 422,
        providerResponseStatusText: 'Unprocessable Entity',
        rootCauseSummary:
          'status=422 Unprocessable Entity | sandbox cannot snapshot right now',
        sandboxId: 'sb-running',
        snapshotStage: 'create_snapshot',
        preSnapshotInstanceStatus: 'running',
        postFailureInstanceStatus: 'running',
        error: 'Status code 422 is not ok',
      }),
      {
        component: 'snapshot_queue',
        level: 'error',
        signal: 'snapshot-failed',
      },
    );
  });

  it('retries createSnapshot failures without marking snapshotFailedAt before a later success', async () => {
    mockGetInstanceStatus.mockResolvedValue({ status: 'running' });
    mockCreateSnapshot
      .mockRejectedValueOnce(
        new Error(
          'Sandbox snapshot failed: Timed out waiting for image to be created',
        ),
      )
      .mockResolvedValueOnce({
        snapshotId: 'snap_retry_success',
      });

    await expect(
      snapshotJob({
        data: { cloudJobId: 123, sandboxId: 'sb-retry-success' },
        id: 'snapshot-123',
        attemptsMade: 0,
        opts: { attempts: 3 },
      } as never),
    ).rejects.toThrow(
      'Sandbox snapshot failed: Timed out waiting for image to be created',
    );

    expect(setFn).not.toHaveBeenCalled();
    expect(mockUpdatePendingEnvironmentSnapshot).not.toHaveBeenCalled();
    expect(mockCaptureBullMqMessage).not.toHaveBeenCalled();
    expect(mockRecordCloudJobEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 123,
        source: 'snapshot_queue',
        eventType: 'decision',
        details: expect.objectContaining({
          decision: 'retry_snapshot_request',
          retryReason: 'snapshot_create_failed',
          queueAttempt: 1,
          queueMaxAttempts: 3,
          attemptsRemaining: 2,
          sandboxId: 'sb-retry-success',
        }),
      }),
    );

    mockRecordCloudJobEvent.mockClear();
    mockRecordMutation.mockClear();

    await snapshotJob({
      data: { cloudJobId: 123, sandboxId: 'sb-retry-success' },
      id: 'snapshot-123',
      attemptsMade: 1,
      opts: { attempts: 3 },
    } as never);

    expect(setFn).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshotId: 'snap_retry_success',
        snapshotFailedAt: null,
        status: CloudTaskStatus.Completed,
      }),
    );
    expect(mockRecordCloudJobEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 123,
        source: 'snapshot_queue',
        eventType: 'completed',
        details: expect.objectContaining({
          snapshotId: 'snap_retry_success',
          queueAttempt: 2,
        }),
      }),
    );
  });

  it('marks snapshotFailedAt only on the final failed attempt', async () => {
    mockGetInstanceStatus.mockResolvedValue({ status: 'running' });
    mockCreateSnapshot.mockRejectedValue(
      new Error(
        'Sandbox snapshot failed: Timed out waiting for image to be created',
      ),
    );

    await expect(
      snapshotJob({
        data: { cloudJobId: 123, sandboxId: 'sb-final-failure' },
        id: 'snapshot-123',
        attemptsMade: 2,
        opts: { attempts: 3 },
      } as never),
    ).rejects.toThrow(
      'Sandbox snapshot failed: Timed out waiting for image to be created',
    );

    expect(setFn).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshotRequestedAt: null,
        sleepRequestedAt: null,
        snapshotFailedAt: expect.any(Date),
        error:
          'Snapshot failed: Sandbox snapshot failed: Timed out waiting for image to be created',
      }),
    );
    expect(mockUpdatePendingEnvironmentSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        environmentId: 'env-1',
        provider: 'modal',
        snapshotStatus: 'failed',
      }),
    );
    expect(mockCaptureBullMqMessage).toHaveBeenCalledWith(
      'Snapshot creation failed',
      expect.objectContaining({
        sandboxId: 'sb-final-failure',
        queueAttempt: 3,
        queueMaxAttempts: 3,
      }),
      {
        component: 'snapshot_queue',
        level: 'error',
        signal: 'snapshot-failed',
      },
    );
  });

  it('retries modal snapshot RPC deadline failures even when the message is not a plain timeout string', async () => {
    mockFindFirst.mockResolvedValue({
      ...baseCloudJob,
      vendor: 'modal',
    });
    mockGetInstanceStatus.mockResolvedValue({ status: 'running' });
    mockCreateSnapshot.mockRejectedValue(
      Object.assign(
        new Error(
          '/modal.task_command_router.TaskCommandRouter/TaskSnapshotFilesystem DEADLINE_EXCEEDED: snapshot still pending on remote worker',
        ),
        {
          name: 'ModalRpcError',
          metadata: {
            grpcStatus: 'DEADLINE_EXCEEDED',
            operation: 'create_snapshot',
            rpcMethod: 'TaskSnapshotFilesystem',
            rpcPath:
              '/modal.task_command_router.TaskCommandRouter/TaskSnapshotFilesystem',
            rpcService: 'modal.task_command_router.TaskCommandRouter',
          },
        },
      ),
    );

    await expect(
      snapshotJob({
        data: { cloudJobId: 123, sandboxId: 'sb-modal-retry' },
        id: 'snapshot-modal-retry',
        attemptsMade: 0,
        opts: { attempts: 3 },
      } as never),
    ).rejects.toThrow(
      '/modal.task_command_router.TaskCommandRouter/TaskSnapshotFilesystem DEADLINE_EXCEEDED: snapshot still pending on remote worker',
    );

    expect(setFn).not.toHaveBeenCalled();
    expect(mockCaptureBullMqMessage).not.toHaveBeenCalled();
    expect(mockRecordCloudJobEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 123,
        source: 'snapshot_queue',
        eventType: 'decision',
        details: expect.objectContaining({
          decision: 'retry_snapshot_request',
          retryReason: 'snapshot_create_failed',
          queueAttempt: 1,
          sandboxId: 'sb-modal-retry',
          providerGrpcStatus: 'DEADLINE_EXCEEDED',
        }),
      }),
    );
  });

  it('records modal RPC timeout details on the final failed attempt', async () => {
    mockFindFirst.mockResolvedValue({
      ...baseCloudJob,
      vendor: 'modal',
    });
    mockGetInstanceStatus.mockResolvedValue({ status: 'running' });
    mockCreateSnapshot.mockRejectedValue(
      Object.assign(
        new Error(
          '/modal.task_command_router.TaskCommandRouter/TaskSnapshotFilesystem DEADLINE_EXCEEDED: Timed out waiting for image to be created',
        ),
        {
          name: 'ModalRpcError',
          metadata: {
            grpcStatus: 'DEADLINE_EXCEEDED',
            operation: 'create_snapshot',
            rpcMethod: 'TaskSnapshotFilesystem',
            rpcPath:
              '/modal.task_command_router.TaskCommandRouter/TaskSnapshotFilesystem',
            rpcService: 'modal.task_command_router.TaskCommandRouter',
          },
        },
      ),
    );

    await expect(
      snapshotJob({
        data: { cloudJobId: 123, sandboxId: 'sb-modal-final-failure' },
        id: 'snapshot-modal-final',
        attemptsMade: 2,
        opts: { attempts: 3 },
      } as never),
    ).rejects.toThrow(
      '/modal.task_command_router.TaskCommandRouter/TaskSnapshotFilesystem DEADLINE_EXCEEDED: Timed out waiting for image to be created',
    );

    expect(mockCaptureBullMqMessage).toHaveBeenCalledWith(
      'Snapshot creation failed',
      expect.objectContaining({
        computeProvider: 'modal',
        sandboxId: 'sb-modal-final-failure',
        providerGrpcStatus: 'DEADLINE_EXCEEDED',
        providerOperation: 'create_snapshot',
        providerRpcMethod: 'TaskSnapshotFilesystem',
        providerRpcPath:
          '/modal.task_command_router.TaskCommandRouter/TaskSnapshotFilesystem',
        providerRpcService: 'modal.task_command_router.TaskCommandRouter',
        rootCauseSummary:
          'grpc=DEADLINE_EXCEEDED | /modal.task_command_router.TaskCommandRouter/TaskSnapshotFilesystem DEADLINE_EXCEEDED: Timed out waiting for image to be created',
      }),
      {
        component: 'snapshot_queue',
        level: 'error',
        signal: 'snapshot-failed',
      },
    );
  });

  it('does not retry permanent createSnapshot failures when attempts remain', async () => {
    mockGetInstanceStatus.mockResolvedValue({ status: 'running' });
    mockCreateSnapshot.mockRejectedValue(
      Object.assign(new Error('Status code 422 is not ok'), {
        response: new Response(
          JSON.stringify({
            error: {
              code: 'snapshot_not_supported',
              message: 'sandbox cannot snapshot right now',
            },
          }),
          {
            status: 422,
            statusText: 'Unprocessable Entity',
            headers: {
              'content-type': 'application/json',
              'x-vercel-request-id': 'req_permanent_failure',
            },
          },
        ),
        text: JSON.stringify({
          error: {
            code: 'snapshot_not_supported',
            message: 'sandbox cannot snapshot right now',
          },
        }),
        json: {
          error: {
            code: 'snapshot_not_supported',
            message: 'sandbox cannot snapshot right now',
          },
        },
        sandboxId: 'sb-permanent-failure',
      }),
    );

    await expect(
      snapshotJob({
        data: { cloudJobId: 123, sandboxId: 'sb-permanent-failure' },
        id: 'snapshot-123',
        attemptsMade: 0,
        opts: { attempts: 3 },
      } as never),
    ).rejects.toMatchObject({
      name: 'UnrecoverableError',
      message: 'Status code 422 is not ok',
    } satisfies Partial<UnrecoverableError>);

    expect(setFn).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshotRequestedAt: null,
        sleepRequestedAt: null,
        snapshotFailedAt: expect.any(Date),
        error: 'Snapshot failed: Status code 422 is not ok',
      }),
    );
    expect(mockUpdatePendingEnvironmentSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        environmentId: 'env-1',
        provider: 'modal',
        snapshotStatus: 'failed',
      }),
    );
    expect(mockCaptureBullMqMessage).toHaveBeenCalledWith(
      'Snapshot creation failed',
      expect.objectContaining({
        sandboxId: 'sb-permanent-failure',
        queueAttempt: 1,
        queueMaxAttempts: 3,
        providerErrorCode: 'snapshot_not_supported',
        providerResponseStatus: 422,
      }),
      {
        component: 'snapshot_queue',
        level: 'error',
        signal: 'snapshot-failed',
      },
    );
    expect(
      mockRecordCloudJobEvent.mock.calls.some(
        ([, event]) =>
          event?.eventType === 'decision' &&
          event?.details?.decision === 'retry_snapshot_request' &&
          event?.details?.sandboxId === 'sb-permanent-failure',
      ),
    ).toBe(false);
  });

  it('reconciles a finished Vercel snapshot when a retry sees the sandbox already stopped', async () => {
    mockFindFirst.mockResolvedValue({
      ...baseCloudJob,
      snapshotRequestedAt: new Date('2026-04-24T06:34:00.000Z'),
    });
    mockGetInstanceStatus.mockResolvedValue({ status: 'stopped' });
    mockFindSnapshotBySourceInstance.mockResolvedValue({
      snapshotId: 'snap_recovered_after_retry',
      sourceInstanceId: 'sb-reconcile-after-retry',
      status: 'created',
      createdAt: new Date('2026-04-24T06:34:41.000Z'),
      expiresAt: new Date('2026-05-24T06:34:41.000Z'),
    });

    await snapshotJob({
      data: {
        cloudJobId: 123,
        sandboxId: 'sb-reconcile-after-retry',
        snapshotIntentId: 'snapshot-123',
        triggerPath: 'due_sleep',
      },
      id: 'snapshot-123',
      attemptsMade: 1,
      opts: { attempts: 3 },
    } as never);

    expect(mockFindSnapshotBySourceInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: 'sb-reconcile-after-retry',
        since: expect.any(Date),
        until: expect.any(Date),
      }),
    );
    expect(setFn).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshotId: 'snap_recovered_after_retry',
        snapshotFailedAt: null,
        status: CloudTaskStatus.Completed,
      }),
    );
    expect(mockUpdatePendingEnvironmentSnapshot).not.toHaveBeenCalled();
    expect(mockRecordMutation).not.toHaveBeenCalled();
    expect(mockRecordCloudJobEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 123,
        source: 'snapshot_queue',
        eventType: 'decision',
        details: expect.objectContaining({
          decision: 'snapshot_reconcile_found',
          reconcileReason: 'instance_not_running_after_retry',
          sandboxId: 'sb-reconcile-after-retry',
          snapshotId: 'snap_recovered_after_retry',
        }),
      }),
    );
  });

  it('keeps non-provider metadata when responseJson has a different shape', async () => {
    mockGetInstanceStatus.mockResolvedValue({ status: 'running' });
    mockCreateSnapshot.mockRejectedValue(
      Object.assign(new Error('Status code 422 is not ok'), {
        response: new Response(
          '{"message":"sandbox cannot snapshot right now"}',
          {
            status: 422,
            statusText: 'Unprocessable Entity',
            headers: {
              'content-type': 'application/json',
              'x-vercel-request-id': 'req_shape_mismatch',
            },
          },
        ),
        text: '{"message":"sandbox cannot snapshot right now"}',
        json: { message: 'sandbox cannot snapshot right now' },
        sandboxId: 'sb-shape-mismatch',
        context: {
          instanceId: 'sb-shape-mismatch',
          instanceStatusAfterError: 'snapshotting',
        },
      }),
    );

    await expect(
      snapshotJob({
        data: { cloudJobId: 123, sandboxId: 'sb-shape-mismatch' },
      } as never),
    ).rejects.toThrow('Status code 422 is not ok');

    expect(mockCaptureBullMqMessage).toHaveBeenCalledWith(
      'Snapshot creation failed',
      expect.objectContaining({
        providerErrorCode: null,
        providerErrorMessage: null,
        providerRequestId: 'req_shape_mismatch',
        providerResponseStatus: 422,
        providerResponseStatusText: 'Unprocessable Entity',
        rootCauseSummary:
          'status=422 Unprocessable Entity | Status code 422 is not ok',
      }),
      {
        component: 'snapshot_queue',
        level: 'error',
        signal: 'snapshot-failed',
      },
    );
  });

  it('reconciles a Vercel sandbox_snapshotting failure by source sandbox id', async () => {
    mockGetInstanceStatus.mockResolvedValue({ status: 'running' });
    mockCreateSnapshot.mockRejectedValue(
      Object.assign(new Error('Status code 422 is not ok'), {
        response: new Response(
          JSON.stringify({
            error: {
              code: 'sandbox_snapshotting',
              message:
                'Sandbox is creating a snapshot and will be stopped shortly.',
            },
          }),
          {
            status: 422,
            statusText: 'Unprocessable Entity',
            headers: {
              'content-type': 'application/json',
              'x-vercel-request-id': 'req_snapshotting',
            },
          },
        ),
        text: JSON.stringify({
          error: {
            code: 'sandbox_snapshotting',
            message:
              'Sandbox is creating a snapshot and will be stopped shortly.',
          },
        }),
        json: {
          error: {
            code: 'sandbox_snapshotting',
            message:
              'Sandbox is creating a snapshot and will be stopped shortly.',
          },
        },
        sandboxId: 'sb-reconcile',
        context: {
          instanceId: 'sb-reconcile',
          instanceStatusAfterError: 'snapshotting',
        },
      }),
    );
    mockFindSnapshotBySourceInstance.mockResolvedValue({
      snapshotId: 'snap_recovered',
      sourceInstanceId: 'sb-reconcile',
      status: 'created',
      createdAt: new Date('2026-04-24T06:34:41.000Z'),
      expiresAt: new Date('2026-05-24T06:34:41.000Z'),
    });

    await snapshotJob({
      data: {
        cloudJobId: 123,
        sandboxId: 'sb-reconcile',
        snapshotIntentId: 'snapshot-123',
        triggerPath: 'due_sleep',
      },
      id: 'snapshot-123',
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as never);

    expect(mockFindSnapshotBySourceInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: 'sb-reconcile',
        since: expect.any(Date),
        until: expect.any(Date),
      }),
    );
    expect(setFn).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshotId: 'snap_recovered',
        snapshotFailedAt: null,
        status: CloudTaskStatus.Completed,
      }),
    );
    expect(mockUpdatePendingEnvironmentSnapshot).not.toHaveBeenCalled();
    expect(mockRecordCloudJobEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 123,
        source: 'snapshot_queue',
        eventType: 'decision',
        details: expect.objectContaining({
          decision: 'snapshot_reconcile_started',
          sandboxId: 'sb-reconcile',
          queueJobId: 'snapshot-123',
          queueAttempt: 1,
          snapshotIntentId: 'snapshot-123',
          triggerPath: 'due_sleep',
        }),
      }),
    );
    expect(mockRecordCloudJobEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 123,
        source: 'snapshot_queue',
        eventType: 'decision',
        details: expect.objectContaining({
          decision: 'snapshot_reconcile_found',
          sandboxId: 'sb-reconcile',
          snapshotId: 'snap_recovered',
          sourceSandboxId: 'sb-reconcile',
          snapshotStatus: 'created',
        }),
      }),
    );
    expect(mockRecordCloudJobEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 123,
        source: 'snapshot_queue',
        eventType: 'completed',
        details: expect.objectContaining({
          snapshotId: 'snap_recovered',
          recoveredFromSnapshotting: true,
          reconciledSnapshotCreatedAt: '2026-04-24T06:34:41.000Z',
        }),
      }),
    );
    expect(mockCaptureBullMqMessage).not.toHaveBeenCalled();
  });
});
