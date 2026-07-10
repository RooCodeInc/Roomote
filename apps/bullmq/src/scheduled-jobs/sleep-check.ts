import {
  type ComputeProvider,
  type TaskPhase,
  CloudTaskStatus,
  sleepCheckManagedComputeProviders,
  isSnapshotCapableComputeProvider,
  isResumableCloudTaskType,
  ACTIVE_TASK_PHASES,
  SNAPSHOT_CHECK_THRESHOLD_MS,
  WORKER_HEARTBEAT_STALE_MS,
} from '@roomote/types';
import {
  type CloudJob,
  db,
  taskRuns,
  createComputeProviderMutationEventRecorder,
  recordCloudJobEvent,
  eq,
  and,
  or,
  isNull,
  isNotNull,
  inArray,
  asc,
  desc,
  gt,
  lte,
  markTaskStartParallelCountEndedAt,
  resolveComputeProviderEnvValues,
  syncTaskStateFromRuns,
} from '@roomote/db/server';
import { createComputeProviderClient } from '@roomote/compute-providers';
import {
  createSnapshot,
  finishCloudJob,
  refreshTaskTitleOnCompletion,
} from '@roomote/sdk/server';

import { tryRecordComputeProviderUsage } from '../compute-provider-usage';
import { captureBullMqMessage } from '../monitoring/sentry';

const ACTIVE_SLEEP_BACKSTOP_EXTENSION_MS = 90 * 1_000;
const SLEEP_CHECK_BATCH_LIMIT = 500;
const ACTIVE_SLEEP_CHECK_STATUSES = [
  CloudTaskStatus.Running,
  CloudTaskStatus.Idle,
];
const BOOTING_NO_HEARTBEAT_STATUSES = [
  CloudTaskStatus.Processing,
  CloudTaskStatus.Preparing,
  CloudTaskStatus.Spawning,
  CloudTaskStatus.Connecting,
];

const SLEEP_CHECK_PROVIDERS = sleepCheckManagedComputeProviders;

type SleepCheckPath =
  | 'due_sleep'
  | 'stale_worker'
  | 'hard_limit'
  | 'booting_no_heartbeat';

type DestroyInstanceReason =
  | 'due_sleep_shutdown'
  | 'provider_timeout_backstop'
  | 'worker_heartbeat_stale'
  | 'booting_no_heartbeat';

type SleepCheckJob = Pick<
  CloudJob,
  | 'id'
  | 'payloadKind'
  | 'status'
  | 'taskPhase'
  | 'machineId'
  | 'vendor'
  | 'taskId'
  | 'snapshotRequestedAt'
  | 'sleepAt'
  | 'sleepRequestedAt'
  | 'startedAt'
  | 'workerHeartbeatAt'
>;

const SENTRY_DESTROY_INSTANCE_REASONS = new Set<DestroyInstanceReason>([
  'provider_timeout_backstop',
  'worker_heartbeat_stale',
  'booting_no_heartbeat',
]);

interface DestroyInstanceAuditDetails {
  path: SleepCheckPath;
  phase: string;
  reason: DestroyInstanceReason;
  [key: string]: unknown;
}

type SleepCheckCandidateSet = {
  dueJob?: SleepCheckJob;
  hardLimitJob?: SleepCheckJob;
  bootingNoHeartbeatJob?: SleepCheckJob;
  staleWorkerJob?: SleepCheckJob;
};

const SLEEP_CHECK_JOB_COLUMNS = {
  id: taskRuns.id,
  payloadKind: taskRuns.payloadKind,
  status: taskRuns.status,
  taskPhase: taskRuns.taskPhase,
  machineId: taskRuns.machineId,
  vendor: taskRuns.vendor,
  taskId: taskRuns.taskId,
  snapshotRequestedAt: taskRuns.snapshotRequestedAt,
  sleepAt: taskRuns.sleepAt,
  sleepRequestedAt: taskRuns.sleepRequestedAt,
  startedAt: taskRuns.startedAt,
  workerHeartbeatAt: taskRuns.workerHeartbeatAt,
} satisfies Record<keyof SleepCheckJob, unknown>;

function getDestroyInstanceSentryMessage(
  reason: DestroyInstanceReason,
): string {
  switch (reason) {
    case 'provider_timeout_backstop':
      return 'Sleep check is destroying sandbox after provider timeout backstop.';
    case 'worker_heartbeat_stale':
      return 'Sleep check is destroying sandbox after stale worker heartbeat.';
    case 'booting_no_heartbeat':
      return 'Sleep check is destroying sandbox after the worker missed its initial heartbeat.';
    case 'due_sleep_shutdown':
      return 'Sleep check is destroying sandbox for scheduled sleep shutdown.';
  }
}

async function createSleepCheckClient(provider: ComputeProvider) {
  switch (provider) {
    case 'modal':
      return createComputeProviderClient({
        provider: 'modal',
        envFallback: await resolveComputeProviderEnvValues('modal'),
      });
    case 'daytona':
      return createComputeProviderClient({
        provider: 'daytona',
        envFallback: await resolveComputeProviderEnvValues('daytona'),
      });
    case 'e2b':
      return createComputeProviderClient({
        provider: 'e2b',
        envFallback: await resolveComputeProviderEnvValues('e2b'),
      });
    default:
      throw new Error(
        `Sleep check has no compute client for provider "${provider}"`,
      );
  }
}

/**
 * Whether the sleep action for this job can be a snapshot. Non-snapshot
 * providers (Daytona) always fall through to the destroy paths, even for
 * job types that would be resumable on snapshot-capable providers.
 */
function isSnapshotResumableSleepCandidate(job: SleepCheckJob): boolean {
  return (
    isResumableCloudTaskType(job.payloadKind) &&
    isSnapshotCapableComputeProvider(job.vendor)
  );
}

function getSleepCheckCandidateKey(
  job: Pick<CloudJob, 'machineId' | 'vendor'>,
): string | null {
  if (!job.machineId || !job.vendor) {
    return null;
  }

  return `${job.vendor}:${job.machineId}`;
}

export const sleepCheckJob = async () => {
  const now = new Date();
  const dueJobs = await db
    .select(SLEEP_CHECK_JOB_COLUMNS)
    .from(taskRuns)
    .where(
      and(
        ...getBaseSleepCheckCandidateConditions(),
        isNotNull(taskRuns.sleepAt),
        lte(taskRuns.sleepAt, now),
      ),
    )
    .orderBy(asc(taskRuns.sleepAt), asc(taskRuns.createdAt))
    .limit(SLEEP_CHECK_BATCH_LIMIT);

  const staleWorkerJobs = await db
    .select(SLEEP_CHECK_JOB_COLUMNS)
    .from(taskRuns)
    .where(
      and(
        ...getBaseSleepCheckCandidateConditions(),
        isNotNull(taskRuns.workerHeartbeatAt),
        lte(
          taskRuns.workerHeartbeatAt,
          new Date(now.getTime() - WORKER_HEARTBEAT_STALE_MS),
        ),
      ),
    )
    .orderBy(asc(taskRuns.workerHeartbeatAt), asc(taskRuns.createdAt))
    .limit(SLEEP_CHECK_BATCH_LIMIT);

  const bootingNoHeartbeatJobs = await db
    .select(SLEEP_CHECK_JOB_COLUMNS)
    .from(taskRuns)
    .where(
      and(
        ...getBaseSleepCheckCandidateConditions(BOOTING_NO_HEARTBEAT_STATUSES),
        isNotNull(taskRuns.startedAt),
        isNull(taskRuns.workerHeartbeatAt),
        lte(
          taskRuns.startedAt,
          new Date(now.getTime() - WORKER_HEARTBEAT_STALE_MS),
        ),
      ),
    )
    .orderBy(asc(taskRuns.startedAt), asc(taskRuns.createdAt))
    .limit(SLEEP_CHECK_BATCH_LIMIT);

  const hardLimitCandidateJobs = await db
    .select(SLEEP_CHECK_JOB_COLUMNS)
    .from(taskRuns)
    .where(
      and(
        ...getBaseSleepCheckCandidateConditions(),
        or(isNull(taskRuns.sleepAt), gt(taskRuns.sleepAt, now)),
      ),
    )
    .orderBy(desc(taskRuns.createdAt))
    .limit(SLEEP_CHECK_BATCH_LIMIT);

  warnIfSleepCheckBatchLimitReached('due sleep', dueJobs.length);
  warnIfSleepCheckBatchLimitReached('stale worker', staleWorkerJobs.length);
  warnIfSleepCheckBatchLimitReached(
    'booting without heartbeat',
    bootingNoHeartbeatJobs.length,
  );
  warnIfSleepCheckBatchLimitReached(
    'provider-timeout backstop',
    hardLimitCandidateJobs.length,
  );

  if (
    dueJobs.length === 0 &&
    staleWorkerJobs.length === 0 &&
    bootingNoHeartbeatJobs.length === 0 &&
    hardLimitCandidateJobs.length === 0
  ) {
    return;
  }

  let snapshotted = 0;
  let shutDown = 0;
  let failed = 0;

  const candidateJobsByMachineId = new Map<string, SleepCheckCandidateSet>();
  const providerClients = new Map<
    ComputeProvider,
    Awaited<ReturnType<typeof createSleepCheckClient>>
  >();

  await mergeSleepCheckCandidates(candidateJobsByMachineId, dueJobs, 'dueJob', {
    path: 'due_sleep',
  });
  await mergeSleepCheckCandidates(
    candidateJobsByMachineId,
    bootingNoHeartbeatJobs,
    'bootingNoHeartbeatJob',
    { path: 'booting_no_heartbeat' },
  );
  await mergeSleepCheckCandidates(
    candidateJobsByMachineId,
    hardLimitCandidateJobs,
    'hardLimitJob',
    { path: 'hard_limit' },
  );
  await mergeSleepCheckCandidates(
    candidateJobsByMachineId,
    staleWorkerJobs,
    'staleWorkerJob',
    { path: 'stale_worker' },
  );

  for (const [, candidates] of candidateJobsByMachineId) {
    const preferredJob =
      candidates.dueJob ??
      candidates.hardLimitJob ??
      candidates.bootingNoHeartbeatJob ??
      candidates.staleWorkerJob;

    if (!preferredJob) {
      continue;
    }

    const fallbackPath: SleepCheckPath = candidates.dueJob
      ? 'due_sleep'
      : candidates.hardLimitJob
        ? 'hard_limit'
        : candidates.bootingNoHeartbeatJob
          ? 'booting_no_heartbeat'
          : 'stale_worker';
    const provider = preferredJob.vendor;

    if (
      !provider ||
      !SLEEP_CHECK_PROVIDERS.includes(
        provider as (typeof SLEEP_CHECK_PROVIDERS)[number],
      )
    ) {
      await recordSleepCheckEvent(
        preferredJob,
        'failed',
        `Skipped ${describeSleepCheckPath(fallbackPath).toLowerCase()} because cloud job #${preferredJob.id} has no supported snapshot-capable provider.`,
        {
          path: fallbackPath,
          decision: 'skip_unsupported_provider',
          ...buildSleepCheckDetails(preferredJob),
        },
      );
      continue;
    }

    let client = providerClients.get(provider);

    if (!client) {
      client = await createSleepCheckClient(provider);
      providerClients.set(provider, client);
    }

    try {
      await recordSleepCheckEvent(
        preferredJob,
        'started',
        `Evaluating ${describeSleepCheckPath(fallbackPath).toLowerCase()} candidates for instance ${preferredJob.machineId}.`,
        {
          decision: 'evaluate_machine_candidates',
          ...buildSleepCheckCandidateDetails(candidates, fallbackPath),
          ...buildSleepCheckDetails(preferredJob),
        },
      );

      const { status, timeoutRemainingMs } = await client.getInstanceStatus({
        instanceId: preferredJob.machineId!,
      });

      await recordSleepCheckEvent(
        preferredJob,
        'decision',
        `Observed instance ${preferredJob.machineId} in status ${status} while evaluating ${describeSleepCheckPath(fallbackPath).toLowerCase()}.`,
        {
          decision: 'instance_status_observed',
          instanceStatus: status,
          timeoutRemainingMs: timeoutRemainingMs ?? null,
          ...buildSleepCheckCandidateDetails(candidates, fallbackPath),
          ...buildSleepCheckDetails(preferredJob),
        },
      );

      if (candidates.dueJob && isSleepDue(candidates.dueJob, now.getTime())) {
        const result = await handleTimedSleepCandidate({
          job: candidates.dueJob,
          path: 'due_sleep',
          status,
          timeoutRemainingMs,
          client,
        });
        snapshotted += result.snapshotted;
        shutDown += result.shutDown;
        failed += result.failed;
        continue;
      }

      if (
        candidates.hardLimitJob &&
        typeof timeoutRemainingMs === 'number' &&
        timeoutRemainingMs <= SNAPSHOT_CHECK_THRESHOLD_MS
      ) {
        const result = await handleTimedSleepCandidate({
          job: candidates.hardLimitJob,
          path: 'hard_limit',
          status,
          timeoutRemainingMs,
          client,
        });
        snapshotted += result.snapshotted;
        shutDown += result.shutDown;
        failed += result.failed;
        continue;
      }

      if (candidates.bootingNoHeartbeatJob) {
        const result = await handleHeartbeatRecoveryCandidate({
          job: candidates.bootingNoHeartbeatJob,
          status,
          client,
          config: BOOTING_NO_HEARTBEAT_RECOVERY,
        });
        snapshotted += result.snapshotted;
        failed += result.failed;
        continue;
      }

      if (candidates.staleWorkerJob) {
        const result = await handleHeartbeatRecoveryCandidate({
          job: candidates.staleWorkerJob,
          status,
          client,
          config: STALE_WORKER_RECOVERY,
        });
        snapshotted += result.snapshotted;
        failed += result.failed;
      }
    } catch (error) {
      await db
        .update(taskRuns)
        .set({
          sleepRequestedAt: null,
          ...(isResumableCloudTaskType(preferredJob.payloadKind)
            ? { snapshotRequestedAt: null }
            : {}),
        })
        .where(eq(taskRuns.id, preferredJob.id))
        .catch(() => {});

      await recordSleepCheckEvent(
        preferredJob,
        'failed',
        `${describeSleepCheckPath(fallbackPath)} handling failed for cloud job #${preferredJob.id}.`,
        {
          path: fallbackPath,
          decision:
            fallbackPath === 'hard_limit'
              ? 'hard_limit_failed'
              : fallbackPath === 'due_sleep'
                ? 'due_sleep_failed'
                : fallbackPath === 'booting_no_heartbeat'
                  ? 'booting_no_heartbeat_recovery_failed'
                  : 'stale_worker_recovery_failed',
          error: error instanceof Error ? error.message : String(error),
          ...buildSleepCheckDetails(preferredJob),
        },
      );
      console.error(
        `[sleepCheck] Failed for job #${preferredJob.id}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  console.log(
    `[sleepCheck] Done. Snapshots=${snapshotted}, shutdowns=${shutDown}, failed=${failed}, total=${candidateJobsByMachineId.size}`,
  );
};

function getBaseSleepCheckCandidateConditions(
  statuses: CloudTaskStatus[] = ACTIVE_SLEEP_CHECK_STATUSES,
) {
  return [
    inArray(taskRuns.status, statuses),
    isNotNull(taskRuns.machineId),
    isNull(taskRuns.sleepRequestedAt),
    isNull(taskRuns.snapshotId),
    isNull(taskRuns.snapshotRequestedAt),
    inArray(taskRuns.vendor, SLEEP_CHECK_PROVIDERS),
  ];
}

function warnIfSleepCheckBatchLimitReached(
  candidateType: string,
  count: number,
) {
  if (count < SLEEP_CHECK_BATCH_LIMIT) {
    return;
  }

  console.warn(
    `[sleepCheck] ${candidateType} candidate query reached the ${SLEEP_CHECK_BATCH_LIMIT} row batch limit; remaining candidates will be retried on the next scheduled run.`,
  );
}

/**
 * Optimistically claim the snapshot slot for a job and enqueue a snapshot.
 * Returns `'enqueued'` when a snapshot job was added, `'duplicate'` when a
 * compatible request is already pending, `'skipped'` when another process
 * already claimed the slot, or `'error'` when the snapshot failed (lock is
 * rolled back so the next cycle can retry).
 */
async function claimAndSnapshot(
  job: SleepCheckJob,
  path: SleepCheckPath,
): Promise<'enqueued' | 'duplicate' | 'skipped' | 'error'> {
  const now = new Date();
  const snapshotIntentId = `${path}-${job.id}-${now.getTime()}`;

  const [claimed] = await db
    .update(taskRuns)
    .set({
      sleepRequestedAt: now,
      snapshotRequestedAt: now,
    })
    .where(
      and(
        eq(taskRuns.id, job.id),
        isNull(taskRuns.sleepRequestedAt),
        isNull(taskRuns.snapshotRequestedAt),
        isNull(taskRuns.snapshotId),
      ),
    )
    .returning({ id: taskRuns.id });

  if (!claimed) {
    return 'skipped';
  }

  await recordSleepCheckEvent(
    job,
    'decision',
    `Claimed snapshot handoff for cloud job #${job.id}.`,
    {
      path,
      decision: 'claim_snapshot',
      snapshotIntentId,
      claimedSleepRequestedAt: now.toISOString(),
      claimedSnapshotRequestedAt: now.toISOString(),
      ...buildSleepCheckDetails(job),
    },
  );

  try {
    const enqueued = await createSnapshot({
      cloudJobId: job.id,
      sandboxId: job.machineId!,
      snapshotIntentId,
      triggerPath: path,
    });

    await recordSleepCheckEvent(
      job,
      'decision',
      enqueued
        ? `Submitted a snapshot request for cloud job #${job.id}.`
        : `Snapshot request for cloud job #${job.id} was already pending.`,
      {
        path,
        decision: enqueued
          ? 'snapshot_request_enqueued'
          : 'snapshot_request_duplicate',
        snapshotIntentId,
        queueJobId: snapshotIntentId,
        ...buildSleepCheckDetails(job),
      },
    );

    return enqueued ? 'enqueued' : 'duplicate';
  } catch (error) {
    // Roll back so the next cycle can retry.
    await db
      .update(taskRuns)
      .set({ sleepRequestedAt: null, snapshotRequestedAt: null })
      .where(eq(taskRuns.id, job.id))
      .catch(() => {});

    await recordSleepCheckEvent(
      job,
      'failed',
      `Snapshot handoff failed for cloud job #${job.id}.`,
      {
        path,
        decision: 'snapshot_request_failed',
        snapshotIntentId,
        clearedSleepRequestedAt: true,
        clearedSnapshotRequestedAt: true,
        error: error instanceof Error ? error.message : String(error),
        ...buildSleepCheckDetails(job),
      },
    );
    console.error(
      `[sleepCheck] Snapshot failed for job #${job.id}:`,
      error instanceof Error ? error.message : String(error),
    );
    return 'error';
  }
}

/**
 * Merge candidate jobs by machine ID while keeping the newest row per category.
 */
async function mergeSleepCheckCandidates(
  candidatesByMachineId: Map<string, SleepCheckCandidateSet>,
  jobs: SleepCheckJob[],
  key: keyof SleepCheckCandidateSet,
  context: { path: SleepCheckPath },
): Promise<void> {
  for (const job of jobs) {
    const candidateKey = getSleepCheckCandidateKey(job);

    if (!candidateKey) {
      continue;
    }

    const existing = candidatesByMachineId.get(candidateKey);

    if (existing?.[key]) {
      await recordSleepCheckEvent(
        job,
        'decision',
        `Skipped ${describeSleepCheckPath(context.path).toLowerCase()} evaluation because ${candidateKey} is already represented by cloud job #${existing[key]!.id}.`,
        {
          path: context.path,
          decision: 'skip_duplicate_machine',
          keptCloudJobId: existing[key]!.id,
          ...buildSleepCheckDetails(job),
        },
      );
      continue;
    }

    candidatesByMachineId.set(candidateKey, {
      ...existing,
      [key]: job,
    });
  }
}

/**
 * Terminal status for a swept job that can no longer keep running. User stop
 * paths persist cancel_requested_at before asking the sandbox to cancel, so a
 * job whose worker died mid-cancel is finalized as Canceled instead of being
 * misreported (and notified) as a runtime failure. Reads a fresh row because
 * the candidate batch may predate the stop request.
 */
async function resolveSweptJobFinalStatus(
  jobId: number,
): Promise<CloudTaskStatus.Failed | CloudTaskStatus.Canceled> {
  const job = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, jobId),
    columns: { cancelRequestedAt: true },
  });

  return job?.cancelRequestedAt
    ? CloudTaskStatus.Canceled
    : CloudTaskStatus.Failed;
}

/**
 * Shared cancel-vs-fail finalization for swept recovery paths. Resolves the
 * terminal status once, finishes the cloud job, records a sleep-check event,
 * and optionally logs — so each recovery branch only supplies copy + details.
 */
async function finalizeSweptJob(params: {
  job: SleepCheckJob;
  error: string;
  canceled: {
    message: string;
    details: Record<string, unknown>;
    consoleMessage?: string;
  };
  failed: {
    message: string;
    details: Record<string, unknown>;
    consoleMessage?: string;
  };
}): Promise<CloudTaskStatus.Failed | CloudTaskStatus.Canceled> {
  const finalStatus = await resolveSweptJobFinalStatus(params.job.id);
  const isCanceled = finalStatus === CloudTaskStatus.Canceled;
  const outcome = isCanceled ? params.canceled : params.failed;

  // Record before finishing so the decision is durable even if finish throws.
  await recordSleepCheckEvent(
    params.job,
    isCanceled ? 'decision' : 'failed',
    outcome.message,
    outcome.details,
  );

  if (outcome.consoleMessage) {
    console.warn(outcome.consoleMessage);
  }

  await finishCloudJob({
    id: params.job.id,
    status: finalStatus,
    error: params.error,
  });

  return finalStatus;
}

async function handleTimedSleepCandidate(params: {
  job: SleepCheckJob;
  path: 'due_sleep' | 'hard_limit';
  status: string;
  timeoutRemainingMs: number | null | undefined;
  client: ReturnType<typeof createComputeProviderClient>;
}): Promise<{ snapshotted: number; shutDown: number; failed: number }> {
  const { job, path, status, timeoutRemainingMs, client } = params;
  const isResumable = isSnapshotResumableSleepCandidate(job);
  const sleepRequestedAt = new Date();

  if (status === 'snapshotting') {
    await recordSnapshotInProgressDecision({
      job,
      path,
      status,
      timeoutRemainingMs,
    });
    return { snapshotted: 0, shutDown: 0, failed: 0 };
  }

  if (status !== 'running') {
    const details = {
      path,
      decision: 'instance_not_running',
      instanceStatus: status,
      timeoutRemainingMs: timeoutRemainingMs ?? null,
      ...buildSleepCheckDetails(job),
    };

    if (job.status === CloudTaskStatus.Idle) {
      await recordSleepCheckEvent(
        job,
        'decision',
        `${describeSleepCheckPath(path)} found idle instance ${job.machineId} in status ${status}.`,
        details,
      );
      await completeIdleJobWithoutSnapshot(
        job,
        `Auto-snapshot could not run because instance ${job.machineId} was ${status}.`,
        details,
      );
      return { snapshotted: 0, shutDown: 0, failed: 0 };
    }

    await finalizeSweptJob({
      job,
      error: `${describeSleepCheckPath(path)} found active instance ${job.machineId} in status ${status}`,
      canceled: {
        message: `${describeSleepCheckPath(path)} found active instance ${job.machineId} in status ${status}; finalizing cloud job #${job.id} as canceled after its stop request.`,
        details,
      },
      failed: {
        message: `${describeSleepCheckPath(path)} found active instance ${job.machineId} in status ${status}; failing the cloud job.`,
        details,
      },
    });
    return { snapshotted: 0, shutDown: 0, failed: 1 };
  }

  if (
    path === 'due_sleep' &&
    ACTIVE_TASK_PHASES.has((job.taskPhase ?? '') as TaskPhase) &&
    typeof timeoutRemainingMs === 'number' &&
    timeoutRemainingMs > SNAPSHOT_CHECK_THRESHOLD_MS
  ) {
    const nextSleepAt = new Date(
      Date.now() +
        Math.min(ACTIVE_SLEEP_BACKSTOP_EXTENSION_MS, timeoutRemainingMs),
    );

    const [extended] = await db
      .update(taskRuns)
      .set({ sleepAt: nextSleepAt })
      .where(
        and(
          eq(taskRuns.id, job.id),
          inArray(taskRuns.taskPhase, [...ACTIVE_TASK_PHASES]),
          isNull(taskRuns.sleepRequestedAt),
          isNull(taskRuns.snapshotRequestedAt),
          isNull(taskRuns.snapshotId),
        ),
      )
      .returning({ id: taskRuns.id });

    if (!extended) {
      console.warn(
        `[sleepCheck] Skipped stale active extension for job #${job.id}: task no longer running`,
      );
      return { snapshotted: 0, shutDown: 0, failed: 0 };
    }

    await recordSleepCheckEvent(
      job,
      'decision',
      `Extended the sleep deadline for active cloud job #${job.id}.`,
      {
        path: 'due_sleep',
        decision: 'extend_active_deadline',
        nextSleepAt: nextSleepAt.toISOString(),
        timeoutRemainingMs,
        ...buildSleepCheckDetails(job),
      },
    );
    console.warn(
      `[sleepCheck] Extended stale active sleep deadline for job #${job.id} to ${nextSleepAt.toISOString()}`,
    );
    return { snapshotted: 0, shutDown: 0, failed: 0 };
  }

  if (isResumable) {
    const result = await claimAndSnapshot(job, path);

    if (result === 'enqueued') {
      console.log(`[sleepCheck] Enqueued snapshot for job #${job.id}`);
      return { snapshotted: 1, shutDown: 0, failed: 0 };
    }

    return { snapshotted: 0, shutDown: 0, failed: 0 };
  }

  const [updated] = await db
    .update(taskRuns)
    .set({ sleepRequestedAt })
    .where(
      and(
        eq(taskRuns.id, job.id),
        isNull(taskRuns.sleepRequestedAt),
        isNull(taskRuns.snapshotRequestedAt),
        isNull(taskRuns.snapshotId),
      ),
    )
    .returning({ id: taskRuns.id });

  if (!updated) {
    return { snapshotted: 0, shutDown: 0, failed: 0 };
  }

  await recordSleepCheckEvent(
    job,
    'decision',
    `Claimed the ${path === 'hard_limit' ? 'provider-timeout' : 'due'} non-resumable shutdown for cloud job #${job.id}.`,
    {
      path,
      decision:
        path === 'hard_limit'
          ? 'claim_hard_limit_non_resumable_shutdown'
          : 'claim_non_resumable_shutdown',
      ...buildSleepCheckDetails(job),
    },
  );

  await destroyInstanceWithAudit(
    job,
    client,
    {
      path,
      phase: 'complete_non_resumable_shutdown',
      reason:
        path === 'hard_limit'
          ? 'provider_timeout_backstop'
          : 'due_sleep_shutdown',
    },
    'sleepCheck',
  );

  const endedAt = new Date();

  await db.transaction(async (tx) => {
    await tx
      .update(taskRuns)
      .set({
        sleepAt: null,
        taskPhase: null,
        status: CloudTaskStatus.Completed,
        completedAt: endedAt,
      })
      .where(eq(taskRuns.id, job.id));

    // Direct-completion path (not via finishCloudJob): derive the task state
    // from all its runs now that this run is completed.
    await syncTaskStateFromRuns(tx, job.taskId);

    await markTaskStartParallelCountEndedAt(tx, {
      runId: job.id,
      endedAt,
    });
  });

  if (job.taskId) {
    try {
      await refreshTaskTitleOnCompletion({
        taskId: job.taskId,
        cloudJobId: job.id,
      });
    } catch (error) {
      console.warn(
        `[sleepCheck] Failed to refresh final title for job #${job.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  await recordSleepCheckEvent(
    job,
    'completed',
    `Shut down instance ${job.machineId} for non-resumable cloud job #${job.id}${path === 'hard_limit' ? ' due to provider-timeout backstop' : ''}.`,
    {
      path,
      decision:
        path === 'hard_limit'
          ? 'complete_hard_limit_non_resumable_shutdown'
          : 'complete_non_resumable_shutdown',
      ...buildSleepCheckDetails(job),
    },
  );
  console.log(`[sleepCheck] Shut down instance for job #${job.id}`);
  return { snapshotted: 0, shutDown: 1, failed: 0 };
}

/**
 * Both the stale-worker and booting-without-heartbeat paths recover a job whose
 * worker heartbeat went (or stayed) missing. They share the same decision tree
 * — fail when the instance is gone, snapshot when resumable, destroy-and-fail
 * otherwise — and differ only in copy and whether an Idle session can be
 * completed instead of failed. This config captures that variance as data.
 */
type HeartbeatRecoveryPath = Extract<
  SleepCheckPath,
  'stale_worker' | 'booting_no_heartbeat'
>;

interface HeartbeatRecoveryConfig {
  path: HeartbeatRecoveryPath;
  destroyReason: DestroyInstanceReason;
  /** Idle sessions only occur on the stale-worker path; booting jobs are never Idle. */
  completeIdleInsteadOfFailing: boolean;
  notRunning: {
    failureError: (machineId: string | null, status: string) => string;
    eventMessage: (
      jobId: number,
      machineId: string | null,
      status: string,
    ) => string;
    consoleMessage: (
      jobId: number,
      machineId: string | null,
      status: string,
    ) => string;
  };
  snapshottedConsoleMessage: (jobId: number) => string;
  destroyAndFail: {
    failureError: (machineId: string | null) => string;
    eventMessage: (jobId: number, machineId: string | null) => string;
    consoleMessage: (jobId: number) => string;
  };
}

const STALE_WORKER_RECOVERY: HeartbeatRecoveryConfig = {
  path: 'stale_worker',
  destroyReason: 'worker_heartbeat_stale',
  completeIdleInsteadOfFailing: true,
  notRunning: {
    failureError: (machineId, status) =>
      `Worker heartbeat stale and instance ${machineId} is ${status}`,
    eventMessage: (jobId, machineId, status) =>
      `Failed stale-worker cloud job #${jobId} because instance ${machineId} was ${status}.`,
    consoleMessage: (jobId, machineId, status) =>
      `[sleepCheck] Failed stale-worker job #${jobId}: instance ${machineId} is ${status}`,
  },
  snapshottedConsoleMessage: (jobId) =>
    `[sleepCheck] Snapshotted stale-worker resumable job #${jobId}`,
  destroyAndFail: {
    failureError: (machineId) =>
      `Worker heartbeat stale for instance ${machineId}`,
    eventMessage: (jobId, machineId) =>
      `Destroyed instance ${machineId} and failed non-resumable stale cloud job #${jobId}.`,
    consoleMessage: (jobId) =>
      `[sleepCheck] Destroyed instance and failed non-resumable stale job #${jobId}`,
  },
};

const BOOTING_NO_HEARTBEAT_RECOVERY: HeartbeatRecoveryConfig = {
  path: 'booting_no_heartbeat',
  destroyReason: 'booting_no_heartbeat',
  completeIdleInsteadOfFailing: false,
  notRunning: {
    failureError: (machineId, status) =>
      `Initial worker heartbeat missing and instance ${machineId} is ${status}`,
    eventMessage: (jobId, machineId, status) =>
      `Failed booting cloud job #${jobId} because its first heartbeat never arrived and instance ${machineId} was ${status}.`,
    consoleMessage: (jobId, machineId, status) =>
      `[sleepCheck] Failed booting job #${jobId}: initial heartbeat missing and instance ${machineId} is ${status}`,
  },
  snapshottedConsoleMessage: (jobId) =>
    `[sleepCheck] Snapshotted booting job #${jobId} after missing initial heartbeat`,
  destroyAndFail: {
    failureError: (machineId) =>
      `Initial worker heartbeat missing for instance ${machineId}`,
    eventMessage: (jobId, machineId) =>
      `Destroyed instance ${machineId} and failed booting cloud job #${jobId} after the worker missed its initial heartbeat.`,
    consoleMessage: (jobId) =>
      `[sleepCheck] Destroyed instance and failed booting job #${jobId} after missing initial heartbeat`,
  },
};

async function handleHeartbeatRecoveryCandidate(params: {
  job: SleepCheckJob;
  status: string;
  client: ReturnType<typeof createComputeProviderClient>;
  config: HeartbeatRecoveryConfig;
}): Promise<{ snapshotted: number; failed: number }> {
  const { job, status, client, config } = params;
  const isResumable = isSnapshotResumableSleepCandidate(job);

  if (status === 'snapshotting') {
    await recordSnapshotInProgressDecision({
      job,
      path: config.path,
      status,
    });
    return { snapshotted: 0, failed: 0 };
  }

  if (status !== 'running') {
    const details = {
      path: config.path,
      decision: 'instance_not_running',
      instanceStatus: status,
      ...buildSleepCheckDetails(job),
    };

    if (
      config.completeIdleInsteadOfFailing &&
      job.status === CloudTaskStatus.Idle
    ) {
      await recordSleepCheckEvent(
        job,
        'decision',
        `Idle stale-worker recovery found instance ${job.machineId} in status ${status}.`,
        details,
      );
      await completeIdleJobWithoutSnapshot(
        job,
        `Idle session could not be snapshotted because instance ${job.machineId} was ${status}.`,
        details,
      );
      return { snapshotted: 0, failed: 0 };
    }

    await finalizeSweptJob({
      job,
      error: config.notRunning.failureError(job.machineId, status),
      canceled: {
        message: `Canceled cloud job #${job.id} after its stop request because instance ${job.machineId} was ${status}.`,
        details,
        consoleMessage: `[sleepCheck] Canceled job #${job.id} after stop request: instance ${job.machineId} is ${status}`,
      },
      failed: {
        message: config.notRunning.eventMessage(job.id, job.machineId, status),
        details,
        consoleMessage: config.notRunning.consoleMessage(
          job.id,
          job.machineId,
          status,
        ),
      },
    });
    return { snapshotted: 0, failed: 1 };
  }

  if (isResumable) {
    const result = await claimAndSnapshot(job, config.path);
    if (result === 'enqueued') {
      console.warn(config.snapshottedConsoleMessage(job.id));
      return { snapshotted: 1, failed: 0 };
    }

    return { snapshotted: 0, failed: 0 };
  }

  await destroyInstanceWithAudit(
    job,
    client,
    {
      path: config.path,
      phase: 'destroy_and_fail_non_resumable',
      reason: config.destroyReason,
    },
    'sleepCheck',
  );

  await finalizeSweptJob({
    job,
    error: config.destroyAndFail.failureError(job.machineId),
    canceled: {
      message: `Destroyed instance ${job.machineId} and canceled cloud job #${job.id} after its stop request.`,
      details: {
        path: config.path,
        decision: 'destroy_and_cancel_after_stop_request',
        ...buildSleepCheckDetails(job),
      },
      consoleMessage: `[sleepCheck] Destroyed instance and canceled job #${job.id} after stop request`,
    },
    failed: {
      message: config.destroyAndFail.eventMessage(job.id, job.machineId),
      details: {
        path: config.path,
        decision: 'destroy_and_fail_non_resumable',
        ...buildSleepCheckDetails(job),
      },
      consoleMessage: config.destroyAndFail.consoleMessage(job.id),
    },
  });
  return { snapshotted: 0, failed: 1 };
}

async function destroyInstanceWithAudit(
  job: SleepCheckJob,
  client: ReturnType<typeof createComputeProviderClient>,
  details: DestroyInstanceAuditDetails,
  logPrefix: string,
) {
  if (SENTRY_DESTROY_INSTANCE_REASONS.has(details.reason)) {
    captureBullMqMessage(
      getDestroyInstanceSentryMessage(details.reason),
      {
        cloudJobId: job.id,
        cloudJobStatus: job.status,
        computeProvider: job.vendor ?? 'docker',
        sandboxId: job.machineId ?? undefined,
        taskId: job.taskId ?? undefined,
        taskPhase: job.taskPhase ?? null,
        triggerPath: details.path,
        rootCauseSummary: details.reason,
      },
      {
        component: 'sleep-check',
        level: 'warning',
        signal: 'sandbox-destroy',
      },
    );
  }

  const recordMutation = createComputeProviderMutationEventRecorder(
    db,
    {
      runId: job.id,
      taskId: job.taskId,
    },
    { logPrefix, logger: console },
  );

  await recordMutation({
    provider: job.vendor ?? 'docker',
    operation: 'destroy_instance',
    eventType: 'started',
    instanceId: job.machineId ?? undefined,
    message: `Calling destroyInstance for instance ${job.machineId}.`,
    details,
  });

  try {
    const result = await client.destroyInstance({ instanceId: job.machineId! });

    await tryRecordComputeProviderUsage({
      runId: job.id,
      lifecycleAction: 'destroy',
      completedAt: new Date(),
      usageObservation: result.usageObservation,
      details: {
        provider: job.vendor ?? 'docker',
        ...details,
      },
      logPrefix,
    });
  } catch (error) {
    await recordMutation({
      provider: job.vendor ?? 'docker',
      operation: 'destroy_instance',
      eventType: 'failed',
      instanceId: job.machineId ?? undefined,
      message: `destroyInstance failed for instance ${job.machineId}.`,
      details: {
        ...details,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }

  await recordMutation({
    provider: job.vendor ?? 'docker',
    operation: 'destroy_instance',
    eventType: 'completed',
    instanceId: job.machineId ?? undefined,
    message: `destroyInstance completed for instance ${job.machineId}.`,
    details,
  });
}

function isSleepDue(
  job: Pick<SleepCheckJob, 'sleepAt'>,
  nowMs: number,
): boolean {
  return job.sleepAt != null && job.sleepAt.getTime() <= nowMs;
}

function describeSleepCheckPath(path: SleepCheckPath): string {
  switch (path) {
    case 'due_sleep':
      return 'Due sleep handling';
    case 'hard_limit':
      return 'Provider-timeout backstop';
    case 'stale_worker':
      return 'Stale-worker recovery';
    case 'booting_no_heartbeat':
      return 'Booting-without-heartbeat recovery';
  }
}

function buildSleepCheckDetails(job: SleepCheckJob) {
  return {
    cloudJobStatus: job.status,
    taskPhase: job.taskPhase ?? null,
    machineId: job.machineId ?? null,
    provider: job.vendor ?? null,
    startedAt: job.startedAt?.toISOString() ?? null,
    sleepAt: job.sleepAt?.toISOString() ?? null,
    sleepRequestedAt: job.sleepRequestedAt?.toISOString() ?? null,
    snapshotRequestedAt: job.snapshotRequestedAt?.toISOString() ?? null,
    workerHeartbeatAt: job.workerHeartbeatAt?.toISOString() ?? null,
    resumable: isResumableCloudTaskType(job.payloadKind),
    taskId: job.taskId,
  };
}

function buildSleepCheckCandidateDetails(
  candidates: SleepCheckCandidateSet,
  preferredPath: SleepCheckPath,
) {
  return {
    preferredPath,
    dueSleepCloudJobId: candidates.dueJob?.id ?? null,
    hardLimitCloudJobId: candidates.hardLimitJob?.id ?? null,
    bootingNoHeartbeatCloudJobId: candidates.bootingNoHeartbeatJob?.id ?? null,
    staleWorkerCloudJobId: candidates.staleWorkerJob?.id ?? null,
  };
}

async function recordSnapshotInProgressDecision(params: {
  job: SleepCheckJob;
  path: SleepCheckPath;
  status: string;
  timeoutRemainingMs?: number | null;
}): Promise<void> {
  const { job, path, status, timeoutRemainingMs } = params;

  await recordSleepCheckEvent(
    job,
    'decision',
    `${describeSleepCheckPath(path)} found instance ${job.machineId} already snapshotting; leaving the cloud job alone.`,
    {
      path,
      decision: 'snapshot_in_progress',
      instanceStatus: status,
      ...(timeoutRemainingMs !== undefined
        ? { timeoutRemainingMs: timeoutRemainingMs ?? null }
        : {}),
      ...buildSleepCheckDetails(job),
    },
  );
}

async function recordSleepCheckEvent(
  job: SleepCheckJob,
  eventType: 'started' | 'decision' | 'completed' | 'failed',
  message: string,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await recordCloudJobEvent(db, {
      runId: job.id,
      taskId: job.taskId,
      source: 'sleep_check',
      eventType,
      message,
      details,
    });
  } catch (error) {
    console.warn(
      `[sleepCheck] Failed to persist cloud job event for #${job.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function completeIdleJobWithoutSnapshot(
  job: SleepCheckJob,
  errorMessage: string,
  details: Record<string, unknown>,
): Promise<void> {
  const sleepRequestedAt = new Date();
  const snapshotFailedAt = new Date();

  const [claimed] = await db
    .update(taskRuns)
    .set({
      sleepRequestedAt,
      snapshotFailedAt,
    })
    .where(
      and(
        eq(taskRuns.id, job.id),
        isNull(taskRuns.sleepRequestedAt),
        isNull(taskRuns.snapshotRequestedAt),
        isNull(taskRuns.snapshotId),
      ),
    )
    .returning({ id: taskRuns.id });

  if (!claimed) {
    await recordSleepCheckEvent(
      job,
      'decision',
      `Skipped completing idle cloud job #${job.id} without a snapshot because another process already claimed it.`,
      { ...details, decision: 'skip_complete_without_snapshot_claim_lost' },
    );
    return;
  }

  await recordSleepCheckEvent(
    job,
    'decision',
    `Claimed idle completion without a snapshot for cloud job #${job.id}.`,
    {
      ...details,
      decision: 'claim_complete_without_snapshot',
      sleepRequestedAt: sleepRequestedAt.toISOString(),
      snapshotFailedAt: snapshotFailedAt.toISOString(),
    },
  );

  try {
    await finishCloudJob({
      id: job.id,
      status: CloudTaskStatus.Completed,
      error: errorMessage,
    });
  } catch (error) {
    await db
      .update(taskRuns)
      .set({
        sleepRequestedAt: null,
        snapshotFailedAt: null,
      })
      .where(eq(taskRuns.id, job.id))
      .catch(() => {});

    throw error;
  }

  await recordSleepCheckEvent(
    job,
    'completed',
    `Completed idle cloud job #${job.id} without a snapshot.`,
    {
      ...details,
      decision: 'complete_without_snapshot',
      snapshotFailedAt: snapshotFailedAt.toISOString(),
      error: errorMessage,
    },
  );
}
