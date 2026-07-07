import { Job, UnrecoverableError } from 'bullmq';

import {
  CloudTaskStatus,
  CloudTaskType,
  extractErrorDetails,
  isObservedTimeoutError,
  resolveComputeProviderTarget,
  SANDBOX_SNAPSHOT_EXPIRY_MS,
  shouldCompleteTaskOnSnapshot,
  withoutCompleteTaskOnSnapshot,
} from '@roomote/types';
import {
  type CloudJob,
  and,
  buildPendingEnvironmentSnapshotMatchForCloudJob,
  createComputeProviderMutationEventRecorder,
  db,
  cloudJobs,
  eq,
  isNull,
  markTaskStartParallelCountEndedAt,
  recordCloudJobEvent,
  attachEnvironmentSnapshot,
  getEnvironmentSnapshotAttachmentSourceForCloudJob,
  resolveComputeProviderEnvValues,
  tasks,
  updatePendingEnvironmentSnapshot,
} from '@roomote/db/server';
import {
  createComputeProviderClient,
  type ComputeProviderClient,
  type CreateSnapshotResult,
  type SourceInstanceSnapshot,
} from '@roomote/compute-providers';
import { drainLinearMessagesToResumeJob } from '@roomote/linear';
import { drainSlackMessagesToResumeJob } from '@roomote/slack';
import { z } from 'zod';

import { tryRecordComputeProviderUsage } from '../compute-provider-usage';
import { captureBullMqMessage } from '../monitoring/sentry';

export interface SnapshotJobData {
  cloudJobId: number;
  sandboxId: string;
  snapshotIntentId?: string;
  triggerPath?: string;
}

type SnapshotJob = Job<SnapshotJobData, void, string>;

const SNAPSHOT_RECONCILE_TIMEOUT_MS = 60_000;
const SNAPSHOT_RECONCILE_INTERVAL_MS = 2_000;
const SNAPSHOT_RECONCILE_SINCE_SKEW_MS = 10_000;
const TRANSIENT_SNAPSHOT_FAILURE_STATUSES = new Set([408, 409, 425, 429]);
const TRANSIENT_MODAL_SNAPSHOT_GRPC_STATUSES = new Set([
  'DEADLINE_EXCEEDED',
  'UNAVAILABLE',
]);
const EMPTY_PROVIDER_ERROR = { code: null, message: null } as const;
const snapshotFailureProviderErrorSchema = z
  .union([
    z
      .string()
      .min(1)
      .transform((message) => ({
        code: null,
        message,
      })),
    z
      .object({
        code: z.union([z.string(), z.number()]).nullish(),
        message: z.string().min(1).nullish(),
      })
      .passthrough()
      .transform(({ code, message }) => ({
        code: code == null ? null : String(code),
        message: message ?? null,
      })),
  ])
  .nullish()
  .transform((error) => error ?? EMPTY_PROVIDER_ERROR);
const snapshotFailureMetadataSchema = z
  .object({
    name: z.string().min(1).nullish(),
    responseHeaders: z
      .record(z.unknown())
      .nullish()
      .transform((headers) =>
        Object.fromEntries(
          Object.entries(headers ?? {}).flatMap(([key, value]) =>
            typeof value === 'string' && value.length > 0
              ? [[key.toLowerCase(), value]]
              : [],
          ),
        ),
      ),
    responseJson: z
      .unknown()
      .nullish()
      .transform((payload) => {
        if (
          typeof payload !== 'object' ||
          payload === null ||
          Array.isArray(payload)
        ) {
          return EMPTY_PROVIDER_ERROR;
        }

        const providerPayload = payload as { error?: unknown };
        const result = snapshotFailureProviderErrorSchema.safeParse(
          providerPayload.error,
        );

        return result.success ? result.data : EMPTY_PROVIDER_ERROR;
      }),
    metadata: z
      .object({
        grpcStatus: z.string().min(1).nullish(),
        modalErrorCode: z.string().min(1).nullish(),
        operation: z.string().min(1).nullish(),
        rpcMethod: z.string().min(1).nullish(),
        rpcPath: z.string().min(1).nullish(),
        rpcService: z.string().min(1).nullish(),
      })
      .passthrough()
      .nullish(),
    responseStatus: z.number().nullish(),
    responseStatusText: z.string().min(1).nullish(),
    responseText: z.string().nullish(),
  })
  .passthrough();

export const snapshotJob = async (job: SnapshotJob): Promise<void> => {
  const {
    cloudJobId,
    sandboxId: instanceId,
    snapshotIntentId = `snapshot-${cloudJobId}`,
    triggerPath = null,
  } = job.data;
  const queueJobId = job.id ?? null;
  const queueAttempt = (job.attemptsMade ?? 0) + 1;
  const queueMaxAttempts = getQueueMaxAttempts(job);
  const attemptsRemaining = Math.max(queueMaxAttempts - queueAttempt, 0);
  const isFinalAttempt = queueAttempt >= queueMaxAttempts;

  const cloudJob = await db.query.cloudJobs.findFirst({
    where: eq(cloudJobs.id, cloudJobId),
  });

  if (!cloudJob) {
    throw new Error(`Cloud job #${cloudJobId} not found`);
  }

  console.log(
    `[SnapshotQueue] 📸 Processing snapshot request for job #${cloudJobId}`,
  );
  await recordSnapshotQueueEvent(cloudJob, {
    eventType: 'started',
    message: `Started processing snapshot request for sandbox ${instanceId}.`,
    details: {
      queueJobId,
      queueAttempt,
      snapshotIntentId,
      triggerPath,
      sandboxId: instanceId,
      cloudJobStatus: cloudJob.status,
      taskPhase: cloudJob.taskPhase ?? null,
      sleepAt: cloudJob.sleepAt?.toISOString() ?? null,
      sleepRequestedAt: cloudJob.sleepRequestedAt?.toISOString() ?? null,
      snapshotRequestedAt: cloudJob.snapshotRequestedAt?.toISOString() ?? null,
      completedAt: cloudJob.completedAt?.toISOString() ?? null,
      workerHeartbeatAt: cloudJob.workerHeartbeatAt?.toISOString() ?? null,
      workerHeartbeatAgeMs: cloudJob.workerHeartbeatAt
        ? Date.now() - cloudJob.workerHeartbeatAt.getTime()
        : null,
    },
  });

  const provider = resolveComputeProviderTarget(cloudJob.vendor);
  const client = createComputeProviderClient({
    provider,
    envFallback: await resolveComputeProviderEnvValues(provider),
  });
  const recordMutation = createComputeProviderMutationEventRecorder(
    db,
    {
      cloudJobId,
      taskId: cloudJob.taskId,
    },
    { logPrefix: 'snapshotJob', logger: console },
  );
  const { status } = await client.getInstanceStatus({ instanceId });
  const snapshotAttemptStartedAt = new Date();
  let snapshotResult: CreateSnapshotResult | null = null;
  let reconciledSnapshot: SourceInstanceSnapshot | null = null;
  const shouldCompleteTask = shouldCompleteTaskOnSnapshot(cloudJob.payload);
  const clearedCompletionPayload = withoutCompleteTaskOnSnapshot(
    cloudJob.payload,
  ) as CloudJob['payload'];

  await recordSnapshotQueueEvent(cloudJob, {
    eventType: 'decision',
    message: `Observed sandbox ${instanceId} in status ${status} before snapshot attempt.`,
    details: {
      queueJobId,
      queueAttempt,
      snapshotIntentId,
      triggerPath,
      decision: 'pre_snapshot_instance_status_observed',
      sandboxId: instanceId,
      instanceStatus: status,
      cloudJobStatus: cloudJob.status,
      taskPhase: cloudJob.taskPhase ?? null,
      sleepAt: cloudJob.sleepAt?.toISOString() ?? null,
      sleepRequestedAt: cloudJob.sleepRequestedAt?.toISOString() ?? null,
      snapshotRequestedAt: cloudJob.snapshotRequestedAt?.toISOString() ?? null,
    },
  });

  if (status !== 'running') {
    reconciledSnapshot = await reconcileSnapshotAfterRetryStatusChange({
      cloudJob,
      client,
      instanceId,
      instanceStatus: status,
      queueAttempt,
      queueJobId,
      snapshotAttemptStartedAt,
      snapshotIntentId,
      triggerPath,
    });

    if (reconciledSnapshot) {
      snapshotResult = { snapshotId: reconciledSnapshot.snapshotId };
    } else if (!isFinalAttempt) {
      await recordSnapshotQueueEvent(cloudJob, {
        eventType: 'decision',
        message: `Snapshot request will retry because sandbox ${instanceId} is ${status}.`,
        details: {
          decision: 'retry_snapshot_request',
          retryReason: 'instance_not_running',
          queueJobId,
          queueAttempt,
          queueMaxAttempts,
          attemptsRemaining,
          snapshotIntentId,
          triggerPath,
          sandboxId: instanceId,
          instanceStatus: status,
        },
      });

      throw new Error(`Instance is not running (status: ${status})`);
    } else {
      await recordSnapshotQueueEvent(cloudJob, {
        eventType: 'failed',
        message: `Snapshot request stopped because sandbox ${instanceId} is ${status}.`,
        details: {
          decision: 'instance_not_running',
          queueJobId,
          queueAttempt,
          queueMaxAttempts,
          snapshotIntentId,
          triggerPath,
          sandboxId: instanceId,
          instanceStatus: status,
          clearedSleepRequestedAt: true,
          clearedSnapshotRequestedAt: true,
        },
      });
      // Clear the request flag and record the error.
      await db
        .update(cloudJobs)
        .set({
          payload: clearedCompletionPayload,
          snapshotRequestedAt: null,
          sleepRequestedAt: null,
          snapshotFailedAt: new Date(),
          error: `Cannot create snapshot: instance is ${status}`,
        })
        .where(and(eq(cloudJobs.id, cloudJobId), isNull(cloudJobs.snapshotId)));

      if (cloudJob.type === CloudTaskType.SnapshotEnvironment) {
        const environmentId = cloudJob.payload.environmentId;

        if (environmentId) {
          const pendingSnapshotMatch =
            buildPendingEnvironmentSnapshotMatchForCloudJob(cloudJob);
          await updatePendingEnvironmentSnapshot(db, {
            environmentId,
            provider,
            snapshotId: null,
            snapshotStatus: 'failed',
            snapshotCreatedAt: null,
            snapshotExpiresAt: null,
            ...pendingSnapshotMatch,
          });
        }
      }

      throw new Error(`Instance is not running (status: ${status})`);
    }
  }

  if (!snapshotResult) {
    try {
      await recordMutation({
        provider,
        operation: 'create_snapshot',
        eventType: 'started',
        instanceId,
        message: `Calling createSnapshot for sandbox ${instanceId}.`,
        details: {
          queueJobId,
          queueAttempt,
          snapshotIntentId,
          triggerPath,
          cloudJobStatus: cloudJob.status,
          taskPhase: cloudJob.taskPhase ?? null,
          sleepAt: cloudJob.sleepAt?.toISOString() ?? null,
          sleepRequestedAt: cloudJob.sleepRequestedAt?.toISOString() ?? null,
          snapshotRequestedAt:
            cloudJob.snapshotRequestedAt?.toISOString() ?? null,
          preSnapshotInstanceStatus: status,
        },
      });

      snapshotResult = await client.createSnapshot({
        instanceId,
      });

      const { snapshotId } = snapshotResult;

      await recordMutation({
        provider,
        operation: 'create_snapshot',
        eventType: 'completed',
        instanceId,
        message: `createSnapshot completed for sandbox ${instanceId}.`,
        details: {
          queueJobId,
          queueAttempt,
          snapshotIntentId,
          triggerPath,
          snapshotId,
        },
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorDetails = extractErrorDetails(error);
      const failureDetails = buildSnapshotFailureDetails(
        errorDetails,
        errorMessage,
      );
      let postFailureInstanceStatus: string | null = null;

      try {
        const postFailureStatus = await client.getInstanceStatus({
          instanceId,
        });
        postFailureInstanceStatus = postFailureStatus.status;
      } catch (statusError) {
        postFailureInstanceStatus = `status_lookup_failed: ${statusError instanceof Error ? statusError.message : String(statusError)}`;
      }

      console.error(
        `[SnapshotQueue] ❌ Failed to create snapshot for job #${cloudJobId}: ${errorMessage}`,
      );

      await recordMutation({
        provider,
        operation: 'create_snapshot',
        eventType: 'failed',
        instanceId,
        message: `createSnapshot failed for sandbox ${instanceId}.`,
        details: {
          queueJobId,
          queueAttempt,
          snapshotIntentId,
          triggerPath,
          error: errorMessage,
          errorDetails,
          ...failureDetails,
          preSnapshotInstanceStatus: status,
          postFailureInstanceStatus,
        },
      });

      reconciledSnapshot = await reconcileSnapshottingFailure({
        cloudJob,
        client,
        errorDetails,
        instanceId,
        postFailureInstanceStatus,
        preSnapshotInstanceStatus: status,
        queueAttempt,
        queueJobId,
        snapshotAttemptStartedAt,
        snapshotIntentId,
        triggerPath,
      });

      if (!reconciledSnapshot) {
        if (
          !isFinalAttempt &&
          isRetryableSnapshotCreateFailure({
            error,
            errorDetails,
            errorMessage,
          })
        ) {
          await recordSnapshotQueueEvent(cloudJob, {
            eventType: 'decision',
            message: `Snapshot creation attempt ${queueAttempt} failed for sandbox ${instanceId}; BullMQ will retry.`,
            details: {
              decision: 'retry_snapshot_request',
              retryReason: 'snapshot_create_failed',
              sandboxId: instanceId,
              queueJobId,
              queueAttempt,
              queueMaxAttempts,
              attemptsRemaining,
              snapshotIntentId,
              triggerPath,
              error: errorMessage,
              errorDetails,
              ...failureDetails,
              preSnapshotInstanceStatus: status,
              postFailureInstanceStatus,
            },
          });

          throw error;
        }

        await db
          .update(cloudJobs)
          .set({
            payload: clearedCompletionPayload,
            snapshotRequestedAt: null,
            sleepRequestedAt: null,
            snapshotFailedAt: new Date(),
            error: `Snapshot failed: ${errorMessage}`,
          })
          .where(
            and(eq(cloudJobs.id, cloudJobId), isNull(cloudJobs.snapshotId)),
          );

        await recordSnapshotQueueEvent(cloudJob, {
          eventType: 'decision',
          message: `Cleared snapshot request state for failed snapshot of sandbox ${instanceId}.`,
          details: {
            queueJobId,
            queueAttempt,
            queueMaxAttempts,
            snapshotIntentId,
            triggerPath,
            decision: 'clear_snapshot_request_after_failure',
            sandboxId: instanceId,
            clearedSleepRequestedAt: true,
            clearedSnapshotRequestedAt: true,
            snapshotFailedAt: true,
            preSnapshotInstanceStatus: status,
            postFailureInstanceStatus,
          },
        });

        // Mark the environment snapshot as failed so the UI stops showing "Snapshotting..."
        if (cloudJob.type === CloudTaskType.SnapshotEnvironment) {
          const environmentId = cloudJob.payload.environmentId;

          if (environmentId) {
            const pendingSnapshotMatch =
              buildPendingEnvironmentSnapshotMatchForCloudJob(cloudJob);
            await updatePendingEnvironmentSnapshot(db, {
              environmentId,
              provider,
              snapshotId: null,
              snapshotStatus: 'failed',
              snapshotCreatedAt: null,
              snapshotExpiresAt: null,
              ...pendingSnapshotMatch,
            });
          }
        }

        await recordSnapshotQueueEvent(cloudJob, {
          eventType: 'failed',
          message: `Snapshot creation failed for sandbox ${instanceId}.`,
          details: {
            sandboxId: instanceId,
            queueJobId,
            queueAttempt,
            queueMaxAttempts,
            snapshotIntentId,
            triggerPath,
            error: errorMessage,
            errorDetails,
            ...failureDetails,
            preSnapshotInstanceStatus: status,
            postFailureInstanceStatus,
          },
        });
        captureBullMqMessage(
          'Snapshot creation failed',
          {
            cloudJobId,
            taskId: cloudJob.taskId,
            computeProvider: provider,
            sandboxId: instanceId,
            queueJobId,
            queueAttempt,
            queueMaxAttempts,
            snapshotIntentId,
            triggerPath,
            cloudJobStatus: cloudJob.status,
            taskPhase: cloudJob.taskPhase ?? null,
            ...failureDetails,
            preSnapshotInstanceStatus: status,
            postFailureInstanceStatus,
            error: errorMessage,
          },
          {
            component: 'snapshot_queue',
            level: 'error',
            signal: 'snapshot-failed',
          },
        );
        throw new UnrecoverableError(errorMessage);
      }

      snapshotResult = { snapshotId: reconciledSnapshot.snapshotId };
    }
  }

  if (!snapshotResult) {
    throw new Error('Snapshot result missing after snapshot attempt');
  }

  const { snapshotId, usageObservation } = snapshotResult;
  const now = new Date();

  const snapshotExpiresAt = new Date(
    now.getTime() + SANDBOX_SNAPSHOT_EXPIRY_MS,
  );

  await db.transaction(async (tx) => {
    await tx
      .update(cloudJobs)
      .set({
        payload: clearedCompletionPayload,
        snapshotId,
        snapshotCreatedAt: now,
        snapshotFailedAt: null,
        sleepAt: null,
        taskPhase: null,
        status: CloudTaskStatus.Completed,
        completedAt: now,
      })
      .where(eq(cloudJobs.id, cloudJobId));

    if (shouldCompleteTask && cloudJob.taskId) {
      await tx
        .update(tasks)
        .set({
          completed: true,
          updatedAt: now,
        })
        .where(eq(tasks.id, cloudJob.taskId));
    }

    await markTaskStartParallelCountEndedAt(tx, {
      cloudJobId,
      endedAt: now,
    });
  });

  await tryRecordComputeProviderUsage({
    cloudJobId,
    lifecycleAction: 'snapshot',
    completedAt: now,
    usageObservation,
    details: {
      provider,
      snapshotId,
      source: 'snapshot_queue',
    },
    logPrefix: 'SnapshotQueue',
  });

  const environmentId = cloudJob.payload.environmentId;

  if (cloudJob.type === CloudTaskType.SnapshotEnvironment && environmentId) {
    const attachmentSource =
      getEnvironmentSnapshotAttachmentSourceForCloudJob(cloudJob);
    const attached = await attachEnvironmentSnapshot(db, {
      environmentId,
      provider,
      snapshotId,
      snapshotStatus: 'ready',
      snapshotCreatedAt: now,
      snapshotExpiresAt,
      attachmentSource,
      maxPendingUpdatedAt: attachmentSource ? null : cloudJob.createdAt,
    });

    if (!attached) {
      await recordSnapshotQueueEvent(cloudJob, {
        eventType: 'decision',
        message: `Skipped attaching stale snapshot ${snapshotId} to environment ${environmentId}.`,
        details: {
          decision: 'skip_attach_stale_environment_snapshot',
          environmentId,
          snapshotId,
          attachmentSource: attachmentSource?.source ?? 'pending_snapshot_row',
          environmentSnapshotId:
            attachmentSource?.source === 'active_snapshot_row'
              ? attachmentSource.environmentSnapshotId
              : attachmentSource?.source === 'pending_snapshot_row'
                ? attachmentSource.environmentSnapshotId
                : null,
          sourceSnapshotId:
            attachmentSource?.source === 'active_snapshot_row'
              ? (attachmentSource.sourceSnapshotId ?? null)
              : null,
          sourceSnapshotCreatedAt:
            attachmentSource?.source === 'active_snapshot_row'
              ? (attachmentSource.sourceSnapshotCreatedAt ?? null)
              : null,
          legacySnapshotId:
            attachmentSource?.source === 'legacy_sandbox_row'
              ? attachmentSource.legacySnapshotId
              : null,
        },
      });
    }
  }

  await recordSnapshotQueueEvent(cloudJob, {
    eventType: 'completed',
    message: `Created snapshot ${snapshotId} for sandbox ${instanceId}.`,
    details: {
      snapshotId,
      sandboxId: instanceId,
      queueJobId,
      queueAttempt,
      snapshotIntentId,
      triggerPath,
      snapshotExpiresAt: snapshotExpiresAt.toISOString(),
      recoveredFromSnapshotting: Boolean(reconciledSnapshot),
      reconciledSnapshotCreatedAt:
        reconciledSnapshot?.createdAt.toISOString() ?? null,
      reconciledSnapshotExpiresAt:
        reconciledSnapshot?.expiresAt?.toISOString() ?? null,
    },
  });
  console.log(
    `[SnapshotQueue] ✅ Created snapshot ${snapshotId} for job #${cloudJobId}`,
  );

  // Drain pending Linear messages to prevent loss during manual snapshots.
  // When a snapshot is triggered via the UI, the worker never calls
  // drainLinearMessages before the container is killed. Any messages queued
  // to the old job's Redis list during the ~30s snapshot window would be
  // orphaned. We check here and create a SnapshotResume job to pick them up.
  if (cloudJob.linearSessionId) {
    try {
      const drainResult = await drainLinearMessagesToResumeJob(
        cloudJob as Parameters<typeof drainLinearMessagesToResumeJob>[0],
        snapshotId,
      );

      if (drainResult.resumed) {
        console.log(
          `[SnapshotQueue] Routed ${drainResult.messageCount} Linear message(s) to SnapshotResume cloud job ${drainResult.cloudJobId}`,
        );
      }
    } catch (drainError) {
      // Log but don't fail the snapshot -- the snapshot itself succeeded.
      console.error(
        `[SnapshotQueue] Failed to drain Linear messages for job #${cloudJobId}: ${drainError instanceof Error ? drainError.message : String(drainError)}`,
      );
    }
  }

  // Drain pending Slack messages using the same pattern as Linear.
  if (cloudJob.slackThreadTs) {
    try {
      const drainResult = await drainSlackMessagesToResumeJob(
        cloudJob as Parameters<typeof drainSlackMessagesToResumeJob>[0],
        snapshotId,
      );

      if (drainResult.resumed) {
        console.log(
          `[SnapshotQueue] Routed ${drainResult.messageCount} Slack message(s) to SnapshotResume cloud job ${drainResult.cloudJobId}`,
        );
      }
    } catch (drainError) {
      // Log but don't fail the snapshot -- the snapshot itself succeeded.
      console.error(
        `[SnapshotQueue] Failed to drain Slack messages for job #${cloudJobId}: ${drainError instanceof Error ? drainError.message : String(drainError)}`,
      );
    }
  }
};

async function recordSnapshotQueueEvent(
  cloudJob: CloudJob,
  input: {
    eventType: 'started' | 'decision' | 'completed' | 'failed';
    message: string;
    details: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await recordCloudJobEvent(db, {
      cloudJobId: cloudJob.id,
      taskId: cloudJob.taskId,
      source: 'snapshot_queue',
      eventType: input.eventType,
      message: input.message,
      details: input.details,
    });
  } catch (error) {
    console.warn(
      `[SnapshotQueue] Failed to persist cloud job event for #${cloudJob.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function getQueueMaxAttempts(job: SnapshotJob): number {
  return Math.max(job.opts?.attempts ?? 1, 1);
}

async function reconcileSnapshottingFailure(input: {
  cloudJob: CloudJob;
  client: ComputeProviderClient;
  errorDetails: Record<string, unknown>;
  instanceId: string;
  postFailureInstanceStatus: string | null;
  preSnapshotInstanceStatus: string;
  queueAttempt: number;
  queueJobId: string | null;
  snapshotAttemptStartedAt: Date;
  snapshotIntentId: string;
  triggerPath: string | null;
}): Promise<SourceInstanceSnapshot | null> {
  if (
    !input.client.findSnapshotBySourceInstance ||
    !isSandboxSnapshottingError(input.errorDetails)
  ) {
    return null;
  }

  return findSnapshotBySourceInstanceWithReconcile(input, {
    lookupAnchor:
      input.cloudJob.snapshotRequestedAt ?? input.snapshotAttemptStartedAt,
    reconcileReason: 'snapshot_create_failed',
  });
}

async function reconcileSnapshotAfterRetryStatusChange(input: {
  cloudJob: CloudJob;
  client: ComputeProviderClient;
  instanceId: string;
  instanceStatus: string;
  queueAttempt: number;
  queueJobId: string | null;
  snapshotAttemptStartedAt: Date;
  snapshotIntentId: string;
  triggerPath: string | null;
}): Promise<SourceInstanceSnapshot | null> {
  if (!input.client.findSnapshotBySourceInstance || input.queueAttempt <= 1) {
    return null;
  }

  return findSnapshotBySourceInstanceWithReconcile(
    {
      cloudJob: input.cloudJob,
      client: input.client,
      instanceId: input.instanceId,
      postFailureInstanceStatus: input.instanceStatus,
      preSnapshotInstanceStatus: input.instanceStatus,
      queueAttempt: input.queueAttempt,
      queueJobId: input.queueJobId,
      snapshotAttemptStartedAt: input.snapshotAttemptStartedAt,
      snapshotIntentId: input.snapshotIntentId,
      triggerPath: input.triggerPath,
    },
    {
      lookupAnchor:
        input.cloudJob.snapshotRequestedAt ?? input.snapshotAttemptStartedAt,
      reconcileReason: 'instance_not_running_after_retry',
    },
  );
}

async function findSnapshotBySourceInstanceWithReconcile(
  input: {
    cloudJob: CloudJob;
    client: ComputeProviderClient;
    instanceId: string;
    postFailureInstanceStatus: string | null;
    preSnapshotInstanceStatus: string;
    queueAttempt: number;
    queueJobId: string | null;
    snapshotAttemptStartedAt: Date;
    snapshotIntentId: string;
    triggerPath: string | null;
  },
  options: {
    lookupAnchor: Date;
    reconcileReason:
      | 'snapshot_create_failed'
      | 'instance_not_running_after_retry';
  },
): Promise<SourceInstanceSnapshot | null> {
  if (!input.client.findSnapshotBySourceInstance) {
    await recordSnapshotQueueEvent(input.cloudJob, {
      eventType: 'decision',
      message: `Snapshot reconciliation unavailable for sandbox ${input.instanceId}.`,
      details: {
        decision: 'snapshot_reconcile_not_found',
        reason: 'provider_lookup_unavailable',
        reconcileReason: options.reconcileReason,
        sandboxId: input.instanceId,
        queueJobId: input.queueJobId,
        queueAttempt: input.queueAttempt,
        snapshotIntentId: input.snapshotIntentId,
        triggerPath: input.triggerPath,
      },
    });
    return null;
  }

  const since = new Date(
    options.lookupAnchor.getTime() - SNAPSHOT_RECONCILE_SINCE_SKEW_MS,
  );
  const startedAt = new Date();

  await recordSnapshotQueueEvent(input.cloudJob, {
    eventType: 'decision',
    message:
      options.reconcileReason === 'snapshot_create_failed'
        ? `Reconciling in-progress Vercel snapshot for sandbox ${input.instanceId}.`
        : `Checking for a completed Vercel snapshot for sandbox ${input.instanceId} after retry status ${input.preSnapshotInstanceStatus}.`,
    details: {
      decision: 'snapshot_reconcile_started',
      reconcileReason: options.reconcileReason,
      sandboxId: input.instanceId,
      queueJobId: input.queueJobId,
      queueAttempt: input.queueAttempt,
      snapshotIntentId: input.snapshotIntentId,
      triggerPath: input.triggerPath,
      lookupAnchor: options.lookupAnchor.toISOString(),
      snapshotAttemptStartedAt: input.snapshotAttemptStartedAt.toISOString(),
      reconcileStartedAt: startedAt.toISOString(),
      since: since.toISOString(),
      timeoutMs: SNAPSHOT_RECONCILE_TIMEOUT_MS,
      pollIntervalMs: SNAPSHOT_RECONCILE_INTERVAL_MS,
      preSnapshotInstanceStatus: input.preSnapshotInstanceStatus,
      postFailureInstanceStatus: input.postFailureInstanceStatus,
    },
  });

  const deadline = Date.now() + SNAPSHOT_RECONCILE_TIMEOUT_MS;
  let lastLookupError: Record<string, unknown> | null = null;

  while (true) {
    const until = new Date(Date.now() + 1_000);

    try {
      const snapshot = await input.client.findSnapshotBySourceInstance({
        instanceId: input.instanceId,
        since,
        until,
      });

      if (snapshot) {
        await recordSnapshotQueueEvent(input.cloudJob, {
          eventType: 'decision',
          message: `Recovered snapshot ${snapshot.snapshotId} for sandbox ${input.instanceId}.`,
          details: {
            decision: 'snapshot_reconcile_found',
            reconcileReason: options.reconcileReason,
            sandboxId: input.instanceId,
            snapshotId: snapshot.snapshotId,
            sourceSandboxId: snapshot.sourceInstanceId,
            snapshotStatus: snapshot.status,
            snapshotCreatedAt: snapshot.createdAt.toISOString(),
            snapshotExpiresAt: snapshot.expiresAt?.toISOString() ?? null,
            queueJobId: input.queueJobId,
            queueAttempt: input.queueAttempt,
            snapshotIntentId: input.snapshotIntentId,
            triggerPath: input.triggerPath,
          },
        });
        return snapshot;
      }
    } catch (lookupError) {
      lastLookupError = extractErrorDetails(lookupError);
    }

    const remainingMs = deadline - Date.now();

    if (remainingMs <= 0) {
      break;
    }

    await sleep(Math.min(SNAPSHOT_RECONCILE_INTERVAL_MS, remainingMs));
  }

  await recordSnapshotQueueEvent(input.cloudJob, {
    eventType: 'decision',
    message: `Could not recover snapshot for sandbox ${input.instanceId}.`,
    details: {
      decision: 'snapshot_reconcile_not_found',
      reason: lastLookupError ? 'lookup_failed' : 'snapshot_not_listed',
      reconcileReason: options.reconcileReason,
      sandboxId: input.instanceId,
      queueJobId: input.queueJobId,
      queueAttempt: input.queueAttempt,
      snapshotIntentId: input.snapshotIntentId,
      triggerPath: input.triggerPath,
      timeoutMs: SNAPSHOT_RECONCILE_TIMEOUT_MS,
      lastLookupError,
    },
  });

  return null;
}

function isSandboxSnapshottingError(
  errorDetails: Record<string, unknown>,
): boolean {
  const { providerErrorCode, responseText } =
    parseSnapshotFailureMetadata(errorDetails);

  return (
    providerErrorCode === 'sandbox_snapshotting' ||
    responseText?.includes('sandbox_snapshotting') === true
  );
}

function isRetryableSnapshotCreateFailure(input: {
  error: unknown;
  errorDetails: Record<string, unknown>;
  errorMessage: string;
}): boolean {
  if (isObservedTimeoutError(input.error)) {
    return true;
  }

  const {
    errorName,
    providerGrpcStatus,
    providerErrorCode,
    providerErrorMessage,
    providerResponseStatus,
    responseText,
  } = parseSnapshotFailureMetadata(input.errorDetails);

  if (
    errorName === 'ObservedTimeoutError' ||
    errorName === 'AbortError' ||
    errorName === 'TimeoutError'
  ) {
    return true;
  }

  if (
    providerResponseStatus !== null &&
    (providerResponseStatus >= 500 ||
      TRANSIENT_SNAPSHOT_FAILURE_STATUSES.has(providerResponseStatus))
  ) {
    return true;
  }

  if (
    providerGrpcStatus !== null &&
    TRANSIENT_MODAL_SNAPSHOT_GRPC_STATUSES.has(providerGrpcStatus)
  ) {
    return true;
  }

  return hasTransientSnapshotFailureSignal([
    input.errorMessage,
    providerErrorCode,
    providerErrorMessage,
    responseText,
  ]);
}

function hasTransientSnapshotFailureSignal(
  values: Array<string | null>,
): boolean {
  const message = values
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();

  return (
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('temporarily unavailable') ||
    message.includes('try again') ||
    message.includes('rate limit')
  );
}

function buildSnapshotFailureDetails(
  errorDetails: Record<string, unknown>,
  errorMessage: string,
): Record<string, string | number | null> {
  const {
    errorName,
    providerGrpcStatus,
    providerModalErrorCode,
    providerErrorCode,
    providerErrorMessage,
    providerOperation,
    providerRequestId,
    providerRpcMethod,
    providerRpcPath,
    providerRpcService,
    providerResponseStatus,
    providerResponseStatusText,
  } = parseSnapshotFailureMetadata(errorDetails);

  return {
    errorName,
    providerGrpcStatus,
    providerModalErrorCode,
    providerErrorCode,
    providerErrorMessage,
    providerOperation,
    providerRequestId,
    providerRpcMethod,
    providerRpcPath,
    providerRpcService,
    providerResponseStatus,
    providerResponseStatusText,
    rootCauseSummary: summarizeSnapshotFailure({
      errorMessage,
      providerGrpcStatus,
      providerErrorCode,
      providerErrorMessage,
      providerResponseStatus,
      providerResponseStatusText,
    }),
    snapshotStage: 'create_snapshot',
  };
}

function summarizeSnapshotFailure(input: {
  errorMessage: string;
  providerGrpcStatus: string | null;
  providerErrorCode: string | null;
  providerErrorMessage: string | null;
  providerResponseStatus: number | null;
  providerResponseStatusText: string | null;
}): string {
  const parts: string[] = [];

  if (input.providerGrpcStatus) {
    parts.push(`grpc=${input.providerGrpcStatus}`);
  }

  if (input.providerErrorCode) {
    parts.push(`code=${input.providerErrorCode}`);
  }

  if (input.providerResponseStatus !== null) {
    parts.push(
      input.providerResponseStatusText
        ? `status=${input.providerResponseStatus} ${input.providerResponseStatusText}`
        : `status=${input.providerResponseStatus}`,
    );
  }

  const primaryMessage = input.providerErrorMessage ?? input.errorMessage;

  if (primaryMessage.length > 0) {
    parts.push(primaryMessage);
  }

  return parts.join(' | ');
}

function parseSnapshotFailureMetadata(errorDetails: Record<string, unknown>) {
  const parsed = snapshotFailureMetadataSchema.safeParse(errorDetails);

  if (!parsed.success) {
    return {
      errorName: null,
      providerGrpcStatus: null,
      providerModalErrorCode: null,
      providerErrorCode: null,
      providerErrorMessage: null,
      providerOperation: null,
      providerRequestId: null,
      providerRpcMethod: null,
      providerRpcPath: null,
      providerRpcService: null,
      providerResponseStatus: null,
      providerResponseStatusText: null,
      responseText: null,
    };
  }

  const {
    metadata,
    name,
    responseHeaders,
    responseJson,
    responseStatus,
    responseStatusText,
    responseText,
  } = parsed.data;

  return {
    errorName: name ?? null,
    providerGrpcStatus: metadata?.grpcStatus ?? null,
    providerModalErrorCode: metadata?.modalErrorCode ?? null,
    providerErrorCode: responseJson.code,
    providerErrorMessage: responseJson.message,
    providerOperation: metadata?.operation ?? null,
    providerRequestId: responseHeaders['x-vercel-request-id'] ?? null,
    providerRpcMethod: metadata?.rpcMethod ?? null,
    providerRpcPath: metadata?.rpcPath ?? null,
    providerRpcService: metadata?.rpcService ?? null,
    providerResponseStatus: responseStatus ?? null,
    providerResponseStatusText: responseStatusText ?? null,
    responseText: responseText ?? null,
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
