import { Job, UnrecoverableError } from 'bullmq';

import {
  RunStatus,
  TaskPayloadKind,
  exitedRunStatuses,
  extractErrorDetails,
  isObservedTimeoutError,
  resolveComputeProviderTarget,
  getSnapshotExpiresAt,
  shouldCompleteTaskOnSnapshot,
  withoutCompleteTaskOnSnapshot,
} from '@roomote/types';
import {
  type TaskRun,
  and,
  buildPendingEnvironmentSnapshotMatchForTaskRun,
  createComputeProviderMutationEventRecorder,
  db,
  taskRuns,
  eq,
  isNull,
  markTaskStartParallelCountEndedAt,
  recordTaskRunEvent,
  attachEnvironmentSnapshot,
  getEnvironmentSnapshotAttachmentSourceForTaskRun,
  resolveComputeProviderEnvValues,
  syncTaskStateFromRuns,
  tasks,
  updatePendingEnvironmentSnapshot,
} from '@roomote/db/server';
import {
  createComputeProviderClient,
  type ComputeProviderClient,
  type CreateSnapshotResult,
  type SourceInstanceSnapshot,
} from '@roomote/compute-providers';
import { drainLinearMessagesToResumeRun } from '@roomote/linear';
import {
  finishRun,
  maybeEnqueueBrainMemoryForCompletedRun,
  withSandboxServerRpcClient,
} from '@roomote/sdk/server';
import { drainSlackMessagesToResumeRun } from '@roomote/slack';
import { z } from 'zod';

import { tryRecordComputeProviderUsage } from '../compute-provider-usage';
import { captureBullMqMessage } from '../monitoring/sentry';

export interface SnapshotJobData {
  runId: number;
  sandboxId: string;
  snapshotIntentId?: string;
  triggerPath?: string;
}

type SnapshotJob = Job<SnapshotJobData, void, string>;

const SNAPSHOT_RECONCILE_TIMEOUT_MS = 60_000;
const SANDBOX_CREDENTIAL_RPC_TIMEOUT_MS = 10_000;
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
    runId,
    sandboxId: instanceId,
    snapshotIntentId = `snapshot-${runId}`,
    triggerPath = null,
  } = job.data;
  const queueJobId = job.id ?? null;
  const queueAttempt = (job.attemptsMade ?? 0) + 1;
  const queueMaxAttempts = getQueueMaxAttempts(job);
  const attemptsRemaining = Math.max(queueMaxAttempts - queueAttempt, 0);
  const isFinalAttempt = queueAttempt >= queueMaxAttempts;

  const taskRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, runId),
  });

  if (!taskRun) {
    throw new Error(`Task run #${runId} not found`);
  }

  console.log(
    `[SnapshotQueue] 📸 Processing snapshot request for task run #${runId}`,
  );
  await recordSnapshotQueueEvent(taskRun, {
    eventType: 'started',
    message: `Started processing snapshot request for sandbox ${instanceId}.`,
    details: {
      queueJobId,
      queueAttempt,
      snapshotIntentId,
      triggerPath,
      sandboxId: instanceId,
      taskRunStatus: taskRun.status,
      taskPhase: taskRun.taskPhase ?? null,
      sleepAt: taskRun.sleepAt?.toISOString() ?? null,
      sleepRequestedAt: taskRun.sleepRequestedAt?.toISOString() ?? null,
      snapshotRequestedAt: taskRun.snapshotRequestedAt?.toISOString() ?? null,
      completedAt: taskRun.completedAt?.toISOString() ?? null,
      workerHeartbeatAt: taskRun.workerHeartbeatAt?.toISOString() ?? null,
      workerHeartbeatAgeMs: taskRun.workerHeartbeatAt
        ? Date.now() - taskRun.workerHeartbeatAt.getTime()
        : null,
    },
  });

  const provider = resolveComputeProviderTarget(taskRun.vendor);
  const client = createComputeProviderClient({
    provider,
    envFallback: await resolveComputeProviderEnvValues(provider),
  });
  const recordMutation = createComputeProviderMutationEventRecorder(
    db,
    {
      runId: runId,
      taskId: taskRun.taskId,
    },
    { logPrefix: 'snapshotJob', logger: console },
  );
  // A stalled-job redelivery can land after `onSnapshotCreated` already
  // persisted the id (see the createSnapshot call below). By then the adapter
  // has terminated the sandbox, and no provider can look an image up by its
  // source instance -- so re-snapshotting is impossible as well as pointless.
  // Finalize from the persisted id instead of failing the run on an instance
  // that is stopped precisely because the snapshot succeeded.
  let snapshotResult: CreateSnapshotResult | null = taskRun.snapshotId
    ? { snapshotId: taskRun.snapshotId }
    : null;
  // Real creation time of the snapshot, carried from the early persist (or
  // from the row when this is a redelivery) so expiry is measured from when
  // the snapshot was taken rather than from whenever this job finishes.
  let persistedSnapshotCreatedAt: Date | null =
    taskRun.snapshotCreatedAt ?? null;
  // Set once `onSnapshotCreated` has recorded an id for this attempt. If the
  // attempt then fails, the failure was in teardown rather than in the
  // snapshot, and the recorded id must be finalized rather than abandoned.
  let persistedSnapshotId: string | null = null;
  const snapshotAttemptStartedAt = new Date();
  let reconciledSnapshot: SourceInstanceSnapshot | null = null;
  const shouldCompleteTask = shouldCompleteTaskOnSnapshot(taskRun.payload);
  const clearedCompletionPayload = withoutCompleteTaskOnSnapshot(
    taskRun.payload,
  ) as TaskRun['payload'];

  if (snapshotResult) {
    await recordSnapshotQueueEvent(taskRun, {
      eventType: 'decision',
      message: `Reusing snapshot ${snapshotResult.snapshotId} already persisted for sandbox ${instanceId}.`,
      details: {
        queueJobId,
        queueAttempt,
        snapshotIntentId,
        triggerPath,
        decision: 'reuse_persisted_snapshot',
        sandboxId: instanceId,
        snapshotId: snapshotResult.snapshotId,
        taskRunStatus: taskRun.status,
        taskPhase: taskRun.taskPhase ?? null,
      },
    });
  }

  // Skipped entirely when a persisted snapshot short-circuited the attempt:
  // the sandbox is already gone and its status tells us nothing useful.
  const status = snapshotResult
    ? null
    : (await client.getInstanceStatus({ instanceId })).status;

  if (status !== null) {
    await recordSnapshotQueueEvent(taskRun, {
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
        taskRunStatus: taskRun.status,
        taskPhase: taskRun.taskPhase ?? null,
        sleepAt: taskRun.sleepAt?.toISOString() ?? null,
        sleepRequestedAt: taskRun.sleepRequestedAt?.toISOString() ?? null,
        snapshotRequestedAt: taskRun.snapshotRequestedAt?.toISOString() ?? null,
      },
    });
  }

  if (status !== null && status !== 'running') {
    reconciledSnapshot = await reconcileSnapshotAfterRetryStatusChange({
      taskRun,
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
      await recordSnapshotQueueEvent(taskRun, {
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
      await recordSnapshotQueueEvent(taskRun, {
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
        .update(taskRuns)
        .set({
          payload: clearedCompletionPayload,
          snapshotRequestedAt: null,
          sleepRequestedAt: null,
          snapshotFailedAt: new Date(),
          error: `Cannot create snapshot: instance is ${status}`,
        })
        .where(and(eq(taskRuns.id, runId), isNull(taskRuns.snapshotId)));

      if (taskRun.payloadKind === TaskPayloadKind.SnapshotEnvironment) {
        const environmentId = taskRun.payload.environmentId;

        if (environmentId) {
          const pendingSnapshotMatch =
            buildPendingEnvironmentSnapshotMatchForTaskRun(taskRun);
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

      await finalizeUnresumableRunAfterSnapshotFailure({
        taskRun,
        instanceId,
        instanceStatus: status,
      });

      throw new Error(`Instance is not running (status: ${status})`);
    }
  }

  // `status` is non-null exactly when no snapshot was already persisted, so
  // this is the same condition as `!snapshotResult` -- spelled out so the
  // status stays narrowed for the reconcile helpers below.
  if (!snapshotResult && status !== null) {
    await requestPreSnapshotScrub({
      taskRun,
      instanceId,
      queueAttempt,
      queueJobId,
      snapshotIntentId,
      triggerPath,
    });

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
          taskRunStatus: taskRun.status,
          taskPhase: taskRun.taskPhase ?? null,
          sleepAt: taskRun.sleepAt?.toISOString() ?? null,
          sleepRequestedAt: taskRun.sleepRequestedAt?.toISOString() ?? null,
          snapshotRequestedAt:
            taskRun.snapshotRequestedAt?.toISOString() ?? null,
          preSnapshotInstanceStatus: status,
        },
      });

      snapshotResult = await client.createSnapshot({
        instanceId,
        onSnapshotCreated: async (createdSnapshotId) => {
          const recorded = await persistCreatedSnapshotId({
            runId,
            taskRun,
            snapshotId: createdSnapshotId,
            instanceId,
            queueJobId,
            queueAttempt,
            snapshotIntentId,
            triggerPath,
          });
          // Whatever is on the row wins, which is not necessarily the id this
          // attempt just produced.
          persistedSnapshotId = recorded.snapshotId;
          persistedSnapshotCreatedAt = recorded.snapshotCreatedAt;
        },
      });

      // A concurrent attempt may have claimed the row while this one was
      // snapshotting. The finalizing update is unconditional, so finalizing
      // our own id here would overwrite the recorded one and point the run at
      // a snapshot no consumer ever saw. Ours becomes an orphaned image.
      if (
        persistedSnapshotId &&
        persistedSnapshotId !== snapshotResult.snapshotId
      ) {
        await recordSnapshotQueueEvent(taskRun, {
          eventType: 'decision',
          message: `Deferring to snapshot ${persistedSnapshotId} recorded for sandbox ${instanceId} by a concurrent attempt.`,
          details: {
            queueJobId,
            queueAttempt,
            snapshotIntentId,
            triggerPath,
            decision: 'defer_to_recorded_snapshot',
            sandboxId: instanceId,
            recordedSnapshotId: persistedSnapshotId,
            orphanedSnapshotId: snapshotResult.snapshotId,
          },
        });

        snapshotResult = {
          ...snapshotResult,
          snapshotId: persistedSnapshotId,
        };
      }

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
      // A terminal finalizer or recovery changed the run while the provider
      // was snapshotting. The adapter propagates callback failures, so stop
      // this attempt before its completion path can overwrite the winner.
      if (error instanceof SnapshotRunOwnershipLostError) {
        throw new UnrecoverableError(error.message);
      }

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
        `[SnapshotQueue] ❌ Failed to create snapshot for task run #${runId}: ${errorMessage}`,
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

      // The provider handed over an id before this attempt threw, so the
      // snapshot itself succeeded and only the teardown that follows it
      // failed. Finalize from the recorded id rather than abandoning it:
      // sleep-check skips runs that already carry a snapshot id, and the
      // abandon path ends in an UnrecoverableError that stops BullMQ from
      // redelivering, so nothing downstream would ever finish this run.
      if (persistedSnapshotId) {
        await recordSnapshotQueueEvent(taskRun, {
          eventType: 'decision',
          message: `Recovered snapshot ${persistedSnapshotId} for sandbox ${instanceId} after the attempt failed during teardown.`,
          details: {
            queueJobId,
            queueAttempt,
            snapshotIntentId,
            triggerPath,
            decision: 'recover_persisted_snapshot_after_failure',
            sandboxId: instanceId,
            snapshotId: persistedSnapshotId,
            error: errorMessage,
            preSnapshotInstanceStatus: status,
            postFailureInstanceStatus,
          },
        });

        snapshotResult = { snapshotId: persistedSnapshotId };
      }

      reconciledSnapshot = snapshotResult
        ? null
        : await reconcileSnapshottingFailure({
            taskRun,
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

      if (!snapshotResult && !reconciledSnapshot) {
        if (
          !isFinalAttempt &&
          isRetryableSnapshotCreateFailure({
            error,
            errorDetails,
            errorMessage,
          })
        ) {
          await recordSnapshotQueueEvent(taskRun, {
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
          .update(taskRuns)
          .set({
            payload: clearedCompletionPayload,
            snapshotRequestedAt: null,
            sleepRequestedAt: null,
            snapshotFailedAt: new Date(),
            error: `Snapshot failed: ${errorMessage}`,
          })
          .where(and(eq(taskRuns.id, runId), isNull(taskRuns.snapshotId)));

        await recordSnapshotQueueEvent(taskRun, {
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

        // The pre-snapshot scrub removed on-disk credentials and quiesced
        // credential writers, but this snapshot attempt is being abandoned
        // and the sandbox may still be running. Ask it to restore credential
        // state so a surviving task can keep working.
        await requestPostFailureCredentialRestore({
          taskRun,
          instanceId,
          queueAttempt,
          queueJobId,
          snapshotIntentId,
          triggerPath,
        });

        // Mark the environment snapshot as failed so the UI stops showing "Snapshotting..."
        if (taskRun.payloadKind === TaskPayloadKind.SnapshotEnvironment) {
          const environmentId = taskRun.payload.environmentId;

          if (environmentId) {
            const pendingSnapshotMatch =
              buildPendingEnvironmentSnapshotMatchForTaskRun(taskRun);
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

        await recordSnapshotQueueEvent(taskRun, {
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
            runId,
            taskId: taskRun.taskId,
            computeProvider: provider,
            sandboxId: instanceId,
            queueJobId,
            queueAttempt,
            queueMaxAttempts,
            snapshotIntentId,
            triggerPath,
            taskRunStatus: taskRun.status,
            taskPhase: taskRun.taskPhase ?? null,
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

        // A sandbox that is dead after the failure means no worker can ever
        // claim or resume this run, the same exposure as the pre-snapshot
        // branch above. The helper no-ops for every other status: transient
        // failures on a live sandbox leave the run alone, and the credential
        // restore above lets a surviving task keep working.
        await finalizeUnresumableRunAfterSnapshotFailure({
          taskRun,
          instanceId,
          instanceStatus: postFailureInstanceStatus ?? 'unknown',
        });

        throw new UnrecoverableError(errorMessage);
      }

      if (reconciledSnapshot) {
        snapshotResult = { snapshotId: reconciledSnapshot.snapshotId };
      }
    }
  }

  if (!snapshotResult) {
    throw new Error('Snapshot result missing after snapshot attempt');
  }

  const { snapshotId, usageObservation } = snapshotResult;
  const now = new Date();

  // Expiry runs from when the snapshot was actually taken. On a redelivery
  // that can be minutes before `now`, and restamping it here would hand out a
  // resume window the snapshot no longer has.
  const snapshotCreatedAt = persistedSnapshotCreatedAt ?? now;

  const snapshotExpiresAt = getSnapshotExpiresAt(snapshotCreatedAt, provider);

  const expectedSnapshotId = persistedSnapshotId ?? taskRun.snapshotId ?? null;
  const completed = await db.transaction(async (tx) => {
    const completedRuns = await tx
      .update(taskRuns)
      .set({
        payload: clearedCompletionPayload,
        snapshotId,
        snapshotCreatedAt,
        snapshotFailedAt: null,
        sleepAt: null,
        taskPhase: null,
        status: RunStatus.Completed,
        completedAt: now,
      })
      .where(
        and(
          eq(taskRuns.id, runId),
          eq(taskRuns.status, taskRun.status),
          eq(taskRuns.machineId, instanceId),
          expectedSnapshotId !== null
            ? eq(taskRuns.snapshotId, expectedSnapshotId)
            : isNull(taskRuns.snapshotId),
        ),
      )
      .returning({ id: taskRuns.id });

    if (completedRuns.length === 0) {
      return false;
    }

    if (shouldCompleteTask && taskRun.taskId) {
      // Derive the task state from all its runs now that this run is completed;
      // the shared helper keeps a non-terminal sibling from being overwritten.
      await syncTaskStateFromRuns(tx, taskRun.taskId);
    }

    await maybeEnqueueBrainMemoryForCompletedRun(tx, runId);

    await markTaskStartParallelCountEndedAt(tx, {
      runId: runId,
      endedAt: now,
    });

    return true;
  });

  if (!completed) {
    await recordSnapshotQueueEvent(taskRun, {
      eventType: 'decision',
      message: `Skipped completing task run #${runId} with snapshot ${snapshotId} because the run advanced concurrently.`,
      details: {
        queueJobId,
        queueAttempt,
        snapshotIntentId,
        triggerPath,
        decision: 'skip_snapshot_completion_claim_lost',
        sandboxId: instanceId,
        snapshotId,
        expectedRunStatus: taskRun.status,
        expectedSnapshotId,
      },
    });
    return;
  }

  await tryRecordComputeProviderUsage({
    runId: runId,
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

  const environmentId = taskRun.payload.environmentId;

  if (
    taskRun.payloadKind === TaskPayloadKind.SnapshotEnvironment &&
    environmentId
  ) {
    const attachmentSource =
      getEnvironmentSnapshotAttachmentSourceForTaskRun(taskRun);
    const attached = await attachEnvironmentSnapshot(db, {
      environmentId,
      provider,
      snapshotId,
      snapshotStatus: 'ready',
      snapshotCreatedAt,
      snapshotExpiresAt,
      attachmentSource,
      maxPendingUpdatedAt: attachmentSource ? null : taskRun.createdAt,
    });

    if (!attached) {
      await recordSnapshotQueueEvent(taskRun, {
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

  await recordSnapshotQueueEvent(taskRun, {
    eventType: 'completed',
    message: `Created snapshot ${snapshotId} for sandbox ${instanceId}.`,
    details: {
      snapshotId,
      sandboxId: instanceId,
      queueJobId,
      queueAttempt,
      snapshotIntentId,
      triggerPath,
      snapshotExpiresAt: snapshotExpiresAt?.toISOString() ?? null,
      recoveredFromSnapshotting: Boolean(reconciledSnapshot),
      reconciledSnapshotCreatedAt:
        reconciledSnapshot?.createdAt.toISOString() ?? null,
      reconciledSnapshotExpiresAt:
        reconciledSnapshot?.expiresAt?.toISOString() ?? null,
    },
  });
  console.log(
    `[SnapshotQueue] ✅ Created snapshot ${snapshotId} for task run #${runId}`,
  );

  // Channel bindings live on the task row now; the drain helpers need them
  // to decide whether a resume run must be created for pending messages.
  const taskChannelBindings = await db.query.tasks.findFirst({
    where: eq(tasks.id, taskRun.taskId),
    columns: {
      slackThreadTs: true,
      linearSessionId: true,
      linearIssueId: true,
      linearOrganizationId: true,
    },
  });

  // Drain pending Linear messages to prevent loss during manual snapshots.
  // When a snapshot is triggered via the UI, the worker never calls
  // drainLinearMessages before the container is killed. Any messages queued
  // to the old run's Redis list during the ~30s snapshot window would be
  // orphaned. We check here and create a SnapshotResume run to pick them up.
  if (taskChannelBindings?.linearSessionId) {
    try {
      const drainResult = await drainLinearMessagesToResumeRun(
        {
          id: taskRun.id,
          linearSessionId: taskChannelBindings.linearSessionId,
          linearIssueId: taskChannelBindings.linearIssueId,
          linearOrganizationId: taskChannelBindings.linearOrganizationId,
          slackThreadTs: taskChannelBindings.slackThreadTs,
          snapshotId,
          payload: taskRun.payload as Record<string, unknown>,
          port: taskRun.port,
        },
        snapshotId,
      );

      if (drainResult.resumed) {
        console.log(
          `[SnapshotQueue] Routed ${drainResult.messageCount} Linear message(s) to SnapshotResume run ${drainResult.runId}`,
        );
      }
    } catch (drainError) {
      // Log but don't fail the snapshot -- the snapshot itself succeeded.
      console.error(
        `[SnapshotQueue] Failed to drain Linear messages for run #${runId}: ${drainError instanceof Error ? drainError.message : String(drainError)}`,
      );
    }
  }

  // Drain pending Slack messages using the same pattern as Linear.
  if (taskChannelBindings?.slackThreadTs) {
    try {
      const drainResult = await drainSlackMessagesToResumeRun(
        {
          id: taskRun.id,
          taskId: taskRun.taskId,
          slackThreadTs: taskChannelBindings.slackThreadTs,
          snapshotId,
          payload: taskRun.payload as Record<string, unknown>,
          port: taskRun.port,
        },
        snapshotId,
      );

      if (drainResult.resumed) {
        console.log(
          `[SnapshotQueue] Routed ${drainResult.messageCount} Slack message(s) to SnapshotResume run ${drainResult.runId}`,
        );
      }
    } catch (drainError) {
      // Log but don't fail the snapshot -- the snapshot itself succeeded.
      console.error(
        `[SnapshotQueue] Failed to drain Slack messages for run #${runId}: ${drainError instanceof Error ? drainError.message : String(drainError)}`,
      );
    }
  }
};

/**
 * Ask the sandbox server to drop worker-managed credential files before the
 * provider snapshots the filesystem. Worker-cooperative paths (the snapshot
 * command and the sleep handoff) already scrub on their own; this covers
 * queue-triggered snapshots where the worker never ran its pre-snapshot
 * scrub, such as the heartbeat-recovery paths. The scrub is idempotent and
 * everything it removes is re-materialized at the next run start, so it is
 * requested on every snapshot. Best-effort only: failures are recorded as
 * run events and never block the snapshot.
 */
async function requestPreSnapshotScrub(input: {
  taskRun: TaskRun;
  instanceId: string;
  queueAttempt: number;
  queueJobId: string | null;
  snapshotIntentId: string;
  triggerPath: string | null;
}): Promise<void> {
  const { taskRun, instanceId } = input;
  const baseDetails = {
    queueJobId: input.queueJobId,
    queueAttempt: input.queueAttempt,
    snapshotIntentId: input.snapshotIntentId,
    triggerPath: input.triggerPath,
    sandboxId: instanceId,
  };

  if (!taskRun.sandboxServerUrl) {
    await recordSnapshotQueueEvent(taskRun, {
      eventType: 'decision',
      message: `Skipped pre-snapshot scrub for sandbox ${instanceId} because the run has no sandbox server URL.`,
      details: {
        ...baseDetails,
        decision: 'pre_snapshot_scrub_skipped',
        reason: 'no_sandbox_server_url',
      },
    });
    return;
  }

  try {
    await withSandboxServerRpcClient({
      runId: taskRun.id,
      // Platform automation with no human actor.
      userId: null,
      sandboxServerUrl: taskRun.sandboxServerUrl,
      timeoutMs: SANDBOX_CREDENTIAL_RPC_TIMEOUT_MS,
      call: (client) => client.commands.scrubSnapshotSecrets.mutate(),
    });

    await recordSnapshotQueueEvent(taskRun, {
      eventType: 'decision',
      message: `Sandbox ${instanceId} scrubbed worker-managed credential files before the snapshot.`,
      details: {
        ...baseDetails,
        decision: 'pre_snapshot_scrub_completed',
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    console.warn(
      `[SnapshotQueue] Pre-snapshot scrub unavailable for task run #${taskRun.id}: ${errorMessage}`,
    );
    await recordSnapshotQueueEvent(taskRun, {
      eventType: 'decision',
      message: `Pre-snapshot scrub was unavailable for sandbox ${instanceId}; continuing with the snapshot.`,
      details: {
        ...baseDetails,
        decision: 'pre_snapshot_scrub_unavailable',
        error: errorMessage,
      },
    });
  }
}

/**
 * After a terminal snapshot failure leaves the sandbox running, ask the
 * sandbox server to restore the credential state the pre-snapshot scrub
 * removed (release the credential write barrier, rewrite token files and
 * env vars) so the surviving task can keep working. Best-effort only:
 * failures are recorded as run events and never affect the failure handling.
 */
async function requestPostFailureCredentialRestore(input: {
  taskRun: TaskRun;
  instanceId: string;
  queueAttempt: number;
  queueJobId: string | null;
  snapshotIntentId: string;
  triggerPath: string | null;
}): Promise<void> {
  const { taskRun, instanceId } = input;
  const baseDetails = {
    queueJobId: input.queueJobId,
    queueAttempt: input.queueAttempt,
    snapshotIntentId: input.snapshotIntentId,
    triggerPath: input.triggerPath,
    sandboxId: instanceId,
  };

  if (!taskRun.sandboxServerUrl) {
    return;
  }

  try {
    await withSandboxServerRpcClient({
      runId: taskRun.id,
      // Platform automation with no human actor.
      userId: null,
      sandboxServerUrl: taskRun.sandboxServerUrl,
      timeoutMs: SANDBOX_CREDENTIAL_RPC_TIMEOUT_MS,
      call: (client) => client.commands.restoreScrubbedCredentials.mutate(),
    });

    await recordSnapshotQueueEvent(taskRun, {
      eventType: 'decision',
      message: `Sandbox ${instanceId} restored credential state after the abandoned snapshot.`,
      details: {
        ...baseDetails,
        decision: 'post_failure_credential_restore_completed',
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    console.warn(
      `[SnapshotQueue] Post-failure credential restore unavailable for task run #${taskRun.id}: ${errorMessage}`,
    );
    await recordSnapshotQueueEvent(taskRun, {
      eventType: 'decision',
      message: `Credential restore was unavailable for sandbox ${instanceId} after the abandoned snapshot.`,
      details: {
        ...baseDetails,
        decision: 'post_failure_credential_restore_unavailable',
        error: errorMessage,
      },
    });
  }
}

/**
 * Write the snapshot id the instant the provider hands it over, before the
 * adapter tears the sandbox down and long before this job reaches its
 * finalizing transaction. Everything between those two points -- the teardown
 * RPC, a stalled-job redelivery, a worker restart -- used to be a window where
 * a perfectly good snapshot was lost with no way to find it again, leaving the
 * task unresumable.
 *
 * Guarded on the observed run status, sandbox, and `snapshotId IS NULL`. If a
 * concurrent snapshot already recorded an id, return that winner. If the row
 * advanced without a snapshot (for example, terminal finalization won), abort
 * this attempt so its later completion cannot overwrite the new state.
 */
async function persistCreatedSnapshotId(input: {
  runId: number;
  taskRun: TaskRun;
  snapshotId: string;
  instanceId: string;
  queueJobId: string | null;
  queueAttempt: number;
  snapshotIntentId: string;
  triggerPath: string | null;
}): Promise<{ snapshotId: string; snapshotCreatedAt: Date }> {
  const snapshotCreatedAt = new Date();

  const [persisted] = await db
    .update(taskRuns)
    .set({
      snapshotId: input.snapshotId,
      snapshotCreatedAt,
      snapshotFailedAt: null,
    })
    .where(
      and(
        eq(taskRuns.id, input.runId),
        eq(taskRuns.status, input.taskRun.status),
        eq(taskRuns.machineId, input.instanceId),
        isNull(taskRuns.snapshotId),
      ),
    )
    .returning({ id: taskRuns.id });

  const details = {
    queueJobId: input.queueJobId,
    queueAttempt: input.queueAttempt,
    snapshotIntentId: input.snapshotIntentId,
    triggerPath: input.triggerPath,
    sandboxId: input.instanceId,
    snapshotId: input.snapshotId,
  };

  if (!persisted) {
    const existing = await db.query.taskRuns.findFirst({
      where: eq(taskRuns.id, input.runId),
      columns: { snapshotId: true, snapshotCreatedAt: true },
    });

    await recordSnapshotQueueEvent(input.taskRun, {
      eventType: 'decision',
      message: existing?.snapshotId
        ? `Snapshot ${input.snapshotId} for sandbox ${input.instanceId} was already persisted by another attempt.`
        : `Skipped persisting snapshot ${input.snapshotId} because task run #${input.runId} advanced concurrently.`,
      details: {
        ...details,
        decision: 'skip_persist_snapshot_id_claim_lost',
        winningSnapshotId: existing?.snapshotId ?? null,
      },
    });

    if (!existing?.snapshotId) {
      throw new SnapshotRunOwnershipLostError(input.runId);
    }

    return {
      snapshotId: existing.snapshotId,
      snapshotCreatedAt: existing.snapshotCreatedAt ?? snapshotCreatedAt,
    };
  }

  await recordSnapshotQueueEvent(input.taskRun, {
    eventType: 'decision',
    message: `Persisted snapshot ${input.snapshotId} for sandbox ${input.instanceId} before teardown.`,
    details: {
      ...details,
      decision: 'persist_snapshot_id_before_teardown',
      snapshotCreatedAt: snapshotCreatedAt.toISOString(),
    },
  });

  return { snapshotId: input.snapshotId, snapshotCreatedAt };
}

async function recordSnapshotQueueEvent(
  taskRun: TaskRun,
  input: {
    eventType: 'started' | 'decision' | 'completed' | 'failed';
    message: string;
    details: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await recordTaskRunEvent(db, {
      runId: taskRun.id,
      taskId: taskRun.taskId,
      source: 'snapshot_queue',
      eventType: input.eventType,
      message: input.message,
      details: input.details,
    });
  } catch (error) {
    console.warn(
      `[SnapshotQueue] Failed to persist task run event for #${taskRun.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function getQueueMaxAttempts(job: SnapshotJob): number {
  return Math.max(job.opts?.attempts ?? 1, 1);
}

const UNRESUMABLE_INSTANCE_STATUSES = new Set(['stopped', 'failed']);

class SnapshotRunOwnershipLostError extends Error {
  constructor(runId: number) {
    super(`Task run #${runId} advanced while its snapshot was being created`);
    this.name = 'SnapshotRunOwnershipLostError';
  }
}

/**
 * A run cannot resume after its sandbox dies without producing a snapshot.
 * Claim the terminal transition before finishRun so concurrent recovery or a
 * late snapshot cannot be overwritten.
 */
async function finalizeUnresumableRunAfterSnapshotFailure(input: {
  taskRun: TaskRun;
  instanceId: string;
  instanceStatus: string;
}): Promise<void> {
  const { taskRun, instanceId, instanceStatus } = input;

  if (!UNRESUMABLE_INSTANCE_STATUSES.has(instanceStatus)) {
    return;
  }

  if (
    (exitedRunStatuses as readonly RunStatus[]).includes(taskRun.status) ||
    taskRun.snapshotId ||
    taskRun.machineId !== instanceId
  ) {
    return;
  }

  const finalStatus =
    taskRun.status === RunStatus.Idle ? RunStatus.Completed : RunStatus.Failed;
  const errorMessage = `Sandbox ${instanceId} was ${instanceStatus} before its snapshot completed; the run cannot be resumed`;
  const now = new Date();

  const claimed = await db.transaction(async (tx) => {
    const claimedRuns = await tx
      .update(taskRuns)
      .set({ status: finalStatus, error: errorMessage, completedAt: now })
      .where(
        and(
          eq(taskRuns.id, taskRun.id),
          eq(taskRuns.status, taskRun.status),
          eq(taskRuns.machineId, instanceId),
          isNull(taskRuns.snapshotId),
        ),
      )
      .returning({ id: taskRuns.id });

    if (claimedRuns.length === 0) {
      return false;
    }

    await syncTaskStateFromRuns(tx, taskRun.taskId);
    if (finalStatus === RunStatus.Completed) {
      await maybeEnqueueBrainMemoryForCompletedRun(tx, taskRun.id);
    }
    return true;
  });

  if (!claimed) {
    return;
  }

  try {
    await finishRun({
      id: taskRun.id,
      status: finalStatus,
      error: errorMessage,
    });
  } catch (error) {
    console.error(
      `[SnapshotQueue] Failed to finalize unresumable task run #${taskRun.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function reconcileSnapshottingFailure(input: {
  taskRun: TaskRun;
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
      input.taskRun.snapshotRequestedAt ?? input.snapshotAttemptStartedAt,
    reconcileReason: 'snapshot_create_failed',
  });
}

async function reconcileSnapshotAfterRetryStatusChange(input: {
  taskRun: TaskRun;
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
      taskRun: input.taskRun,
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
        input.taskRun.snapshotRequestedAt ?? input.snapshotAttemptStartedAt,
      reconcileReason: 'instance_not_running_after_retry',
    },
  );
}

async function findSnapshotBySourceInstanceWithReconcile(
  input: {
    taskRun: TaskRun;
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
    await recordSnapshotQueueEvent(input.taskRun, {
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

  await recordSnapshotQueueEvent(input.taskRun, {
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
        await recordSnapshotQueueEvent(input.taskRun, {
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

  await recordSnapshotQueueEvent(input.taskRun, {
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
