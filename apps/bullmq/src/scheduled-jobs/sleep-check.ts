import {
  type ComputeProvider,
  type TaskPhase,
  RunStatus,
  sleepCheckManagedComputeProviders,
  isStandbyResumeCapableComputeProvider,
  isTaskResumeCapableComputeProvider,
  isResumableTaskPayloadKind,
  ACTIVE_TASK_PHASES,
  SNAPSHOT_CHECK_THRESHOLD_MS,
  WORKER_HEARTBEAT_STALE_MS,
} from '@roomote/types';
import {
  type TaskRun,
  db,
  taskRuns,
  createComputeProviderMutationEventRecorder,
  recordTaskRunEvent,
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
import {
  AzureDataPlaneError,
  createComputeProviderClient,
  type ComputeProviderClient,
} from '@roomote/compute-providers';
import {
  claimMachineDestroy,
  createSnapshot,
  finishRun,
  refreshTaskTitleOnCompletion,
} from '@roomote/sdk/server';

import { tryRecordComputeProviderUsage } from '../compute-provider-usage';
import { captureBullMqMessage } from '../monitoring/sentry';

const ACTIVE_SLEEP_BACKSTOP_EXTENSION_MS = 90 * 1_000;
const SLEEP_CHECK_BATCH_LIMIT = 500;
const ACTIVE_SLEEP_CHECK_STATUSES = [RunStatus.Running, RunStatus.Idle];
const BOOTING_NO_HEARTBEAT_STATUSES = [
  RunStatus.Processing,
  RunStatus.Preparing,
  RunStatus.Spawning,
  RunStatus.Connecting,
];
const STALE_WORKER_STATUSES = [
  ...ACTIVE_SLEEP_CHECK_STATUSES,
  ...BOOTING_NO_HEARTBEAT_STATUSES,
];

const SLEEP_CHECK_PROVIDERS = sleepCheckManagedComputeProviders;

type SleepCheckPath =
  | 'due_sleep'
  | 'manual_sleep'
  | 'stale_worker'
  | 'hard_limit'
  | 'booting_no_heartbeat';

type DestroyInstanceReason =
  | 'due_sleep_shutdown'
  | 'provider_timeout_backstop'
  | 'worker_heartbeat_stale'
  | 'booting_no_heartbeat';

type SleepCheckJob = Pick<
  TaskRun,
  | 'id'
  | 'payloadKind'
  | 'status'
  | 'taskPhase'
  | 'machineId'
  | 'vendor'
  | 'taskId'
  | 'snapshotRequestedAt'
  | 'sandboxCmdId'
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
  sandboxCmdId: taskRuns.sandboxCmdId,
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

function buildSleepCheckClient(
  provider: ComputeProvider,
  envFallback: Partial<Record<string, string>>,
) {
  switch (provider) {
    case 'modal':
      return createComputeProviderClient({ provider: 'modal', envFallback });
    case 'roomote':
      return createComputeProviderClient({ provider: 'roomote', envFallback });
    case 'daytona':
      return createComputeProviderClient({ provider: 'daytona', envFallback });
    case 'e2b':
      return createComputeProviderClient({ provider: 'e2b', envFallback });
    case 'blaxel':
      return createComputeProviderClient({ provider: 'blaxel', envFallback });
    case 'box':
      return createComputeProviderClient({ provider: 'box', envFallback });
    case 'azure':
      return createComputeProviderClient({ provider: 'azure', envFallback });
    case 'docker':
      return createComputeProviderClient({ provider: 'docker' });
    default:
      throw new Error(
        `Sleep check has no compute client for provider "${provider}"`,
      );
  }
}

interface CachedSleepCheckClient {
  client: ReturnType<typeof buildSleepCheckClient>;
  fingerprint: string;
}

// Reuse one client per provider across scheduler ticks. Building a fresh SDK
// client every minute retained each client's connection state (pinned via the
// adapters' static sandbox caches) on deployments that always have active
// runs, leaking ~1.5 MB/min until the bullmq service hit its heap cap. The
// fingerprint rebuilds the client when the deployment's provider credentials
// change.
const sleepCheckClientCache = new Map<
  ComputeProvider,
  CachedSleepCheckClient
>();

/** Test-only: drop cached clients so mocks do not leak across tests. */
export function clearSleepCheckClientCache(): void {
  sleepCheckClientCache.clear();
}

function fingerprintEnvValues(values: Partial<Record<string, string>>): string {
  return JSON.stringify(
    Object.entries(values)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

async function getSleepCheckClient(provider: ComputeProvider) {
  const envValues =
    provider === 'docker'
      ? {}
      : await resolveComputeProviderEnvValues(provider);
  const fingerprint = fingerprintEnvValues(envValues);
  const cached = sleepCheckClientCache.get(provider);

  if (cached && cached.fingerprint === fingerprint) {
    return cached.client;
  }

  const client = buildSleepCheckClient(provider, envValues);
  sleepCheckClientCache.set(provider, { client, fingerprint });
  return client;
}

/**
 * Whether the sleep action can preserve this task through either an immutable
 * snapshot or a provider-native standby handle. Other providers fall through
 * to the destroy paths.
 */
function isResumableSleepCandidate(job: SleepCheckJob): boolean {
  return (
    isResumableTaskPayloadKind(job.payloadKind) &&
    isTaskResumeCapableComputeProvider(job.vendor)
  );
}

function getSleepCheckCandidateKey(
  job: Pick<TaskRun, 'machineId' | 'vendor'>,
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
        ...getBaseSleepCheckCandidateConditions(STALE_WORKER_STATUSES),
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
    Awaited<ReturnType<typeof getSleepCheckClient>>
  >();
  // Client construction can throw for providers that are not configured on
  // this deployment (e.g. stale rows from another vendor). Cache the failure
  // per sweep so one bad provider skips only its own candidates instead of
  // aborting the whole job — and isn't rebuilt for every candidate.
  const providerClientFailures = new Map<ComputeProvider, string>();

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
        `Skipped ${describeSleepCheckPath(fallbackPath).toLowerCase()} because task run #${preferredJob.id} has no supported snapshot-capable provider.`,
        {
          path: fallbackPath,
          decision: 'skip_unsupported_provider',
          ...buildSleepCheckDetails(preferredJob),
        },
      );
      continue;
    }

    let client = providerClients.get(provider);

    if (!client && !providerClientFailures.has(provider)) {
      try {
        client = await getSleepCheckClient(provider);
        providerClients.set(provider, client);
      } catch (error) {
        providerClientFailures.set(
          provider,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    if (!client) {
      const clientError =
        providerClientFailures.get(provider) ?? 'unknown error';

      await recordSleepCheckEvent(
        preferredJob,
        'failed',
        `Skipped ${describeSleepCheckPath(fallbackPath).toLowerCase()} for task run #${preferredJob.id} because the ${provider} compute client could not be created.`,
        {
          path: fallbackPath,
          decision: 'skip_provider_client_unavailable',
          error: clientError,
          ...buildSleepCheckDetails(preferredJob),
        },
      );
      console.error(
        `[sleepCheck] Skipping task run #${preferredJob.id}: could not create ${provider} compute client:`,
        clientError,
      );
      continue;
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
      if (isInstanceNotFoundError(error)) {
        // The instance is gone for good — every future evaluation would fail
        // the same way (observed as an endless hard_limit retry loop on azure
        // runs whose sandboxes were deleted out-of-band). Finalize the run
        // instead of retrying forever.
        failed += 1;
        await finalizeRunForMissingInstance(preferredJob, fallbackPath);
        continue;
      }

      await db
        .update(taskRuns)
        .set({
          sleepRequestedAt: null,
          ...(isResumableTaskPayloadKind(preferredJob.payloadKind)
            ? { snapshotRequestedAt: null }
            : {}),
        })
        .where(eq(taskRuns.id, preferredJob.id))
        .catch(() => {});

      await recordSleepCheckEvent(
        preferredJob,
        'failed',
        `${describeSleepCheckPath(fallbackPath)} handling failed for task run #${preferredJob.id}.`,
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
        `[sleepCheck] Failed for task run #${preferredJob.id}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  console.log(
    `[sleepCheck] Done. Preserved=${snapshotted}, shutdowns=${shutDown}, failed=${failed}, total=${candidateJobsByMachineId.size}`,
  );
};

function getBaseSleepCheckCandidateConditions(
  statuses: RunStatus[] = ACTIVE_SLEEP_CHECK_STATUSES,
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
    `Claimed snapshot handoff for task run #${job.id}.`,
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
      runId: job.id,
      sandboxId: job.machineId!,
      snapshotIntentId,
      triggerPath: path,
    });

    await recordSleepCheckEvent(
      job,
      'decision',
      enqueued
        ? `Submitted a snapshot request for task run #${job.id}.`
        : `Snapshot request for task run #${job.id} was already pending.`,
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
      `Snapshot handoff failed for task run #${job.id}.`,
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
      `[sleepCheck] Snapshot failed for task run #${job.id}:`,
      error instanceof Error ? error.message : String(error),
    );
    return 'error';
  }
}

async function claimAndEnterStandby(
  job: SleepCheckJob,
  client: ComputeProviderClient,
  path: SleepCheckPath,
): Promise<'completed' | 'skipped' | 'error'> {
  const requestedAt = new Date();
  const [claimed] = await db
    .update(taskRuns)
    .set({ sleepRequestedAt: requestedAt })
    .where(
      and(
        eq(taskRuns.id, job.id),
        isNull(taskRuns.sleepRequestedAt),
        isNull(taskRuns.snapshotRequestedAt),
        isNull(taskRuns.snapshotId),
      ),
    )
    .returning({ id: taskRuns.id });

  if (!claimed) return 'skipped';

  const recordMutation = createComputeProviderMutationEventRecorder(
    db,
    { runId: job.id, taskId: job.taskId },
    { logPrefix: 'sleepCheck', logger: console },
  );

  await recordSleepCheckEvent(
    job,
    'decision',
    `Claimed standby handoff for task run #${job.id}.`,
    {
      path,
      decision: 'claim_standby',
      claimedSleepRequestedAt: requestedAt.toISOString(),
      ...buildSleepCheckDetails(job),
    },
  );

  try {
    if (!client.enterStandby) {
      throw new Error(`${job.vendor} client does not support standby`);
    }

    await recordMutation({
      provider: job.vendor!,
      operation: 'enter_standby',
      eventType: 'started',
      instanceId: job.machineId!,
      message: `Entering standby for instance ${job.machineId}.`,
      details: { path, commandId: job.sandboxCmdId ?? null },
    });
    const result = await client.enterStandby({
      instanceId: job.machineId!,
      commandId: job.sandboxCmdId ?? undefined,
    });
    await recordMutation({
      provider: job.vendor!,
      operation: 'enter_standby',
      eventType: 'completed',
      instanceId: job.machineId!,
      message: `Instance ${job.machineId} is ready to enter standby.`,
      details: { path, resumeHandle: result.resumeHandle },
    });

    const completedAt = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(taskRuns)
        .set({
          snapshotId: result.resumeHandle,
          snapshotCreatedAt: completedAt,
          snapshotFailedAt: null,
          sleepAt: null,
          taskPhase: null,
          status: RunStatus.Completed,
          completedAt,
        })
        .where(eq(taskRuns.id, job.id));
      await syncTaskStateFromRuns(tx, job.taskId);
      await markTaskStartParallelCountEndedAt(tx, {
        runId: job.id,
        endedAt: completedAt,
      });
    });

    await recordSleepCheckEvent(
      job,
      'completed',
      `Retained ${job.vendor} sandbox ${job.machineId} on standby for task run #${job.id}.`,
      {
        path,
        decision: 'standby_completed',
        resumeHandle: result.resumeHandle,
        ...buildSleepCheckDetails(job),
      },
    );

    return 'completed';
  } catch (error) {
    await db
      .update(taskRuns)
      .set({ sleepRequestedAt: null })
      .where(eq(taskRuns.id, job.id))
      .catch(() => {});

    await recordSleepCheckEvent(
      job,
      'failed',
      `Standby handoff failed for task run #${job.id}.`,
      {
        path,
        decision: 'standby_failed',
        clearedSleepRequestedAt: true,
        error: error instanceof Error ? error.message : String(error),
        ...buildSleepCheckDetails(job),
      },
    );
    return 'error';
  }
}

async function claimResumableSleep(
  job: SleepCheckJob,
  client: ComputeProviderClient,
  path: SleepCheckPath,
): Promise<boolean> {
  if (isStandbyResumeCapableComputeProvider(job.vendor)) {
    return (await claimAndEnterStandby(job, client, path)) === 'completed';
  }

  return (await claimAndSnapshot(job, path)) === 'enqueued';
}

/**
 * Process a user-requested sleep immediately. Unlike the scheduled due-sleep
 * path, this intentionally does not extend the deadline for an active phase.
 */
export async function sleepTaskRunNow(runId: number): Promise<void> {
  const job = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, runId),
    columns: {
      id: true,
      payloadKind: true,
      status: true,
      taskPhase: true,
      machineId: true,
      vendor: true,
      taskId: true,
      snapshotRequestedAt: true,
      sandboxCmdId: true,
      sleepAt: true,
      sleepRequestedAt: true,
      startedAt: true,
      workerHeartbeatAt: true,
      snapshotId: true,
    },
  });

  if (!job) {
    throw new Error(`Task run #${runId} was not found`);
  }

  if (!ACTIVE_SLEEP_CHECK_STATUSES.includes(job.status)) {
    throw new Error(`Task run #${runId} is not active`);
  }

  if (!job.machineId || !job.vendor) {
    throw new Error(`Task run #${runId} has no active machine`);
  }

  if (
    !isResumableTaskPayloadKind(job.payloadKind) ||
    !isTaskResumeCapableComputeProvider(job.vendor)
  ) {
    throw new Error(`Task run #${runId} does not support resumable sleep`);
  }

  if (job.snapshotId || job.snapshotRequestedAt || job.sleepRequestedAt) {
    return;
  }

  const client = await getSleepCheckClient(job.vendor);
  const { status } = await client.getInstanceStatus({
    instanceId: job.machineId,
  });

  if (status !== 'running') {
    throw new Error(
      `Cannot put task run #${runId} to sleep because its instance is ${status}`,
    );
  }

  if (isStandbyResumeCapableComputeProvider(job.vendor)) {
    const result = await claimAndEnterStandby(job, client, 'manual_sleep');

    if (result === 'error') {
      throw new Error(`Failed to put task run #${runId} on standby`);
    }

    return;
  }

  const result = await claimAndSnapshot(job, 'manual_sleep');

  if (result === 'error') {
    throw new Error(`Failed to snapshot task run #${runId}`);
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
        `Skipped ${describeSleepCheckPath(context.path).toLowerCase()} evaluation because ${candidateKey} is already represented by task run #${existing[key]!.id}.`,
        {
          path: context.path,
          decision: 'skip_duplicate_machine',
          keptRunId: existing[key]!.id,
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
): Promise<RunStatus.Failed | RunStatus.Canceled> {
  const job = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, jobId),
    columns: { cancelRequestedAt: true },
  });

  return job?.cancelRequestedAt ? RunStatus.Canceled : RunStatus.Failed;
}

/**
 * Whether the error definitively means the provider instance no longer
 * exists (as opposed to a transient API failure). Only definitive not-found
 * errors may finalize runs; anything else must keep retrying. Azure throws
 * AzureDataPlaneError 404 for deleted sandboxes; other providers' not-found
 * shapes can extend this classifier as needed.
 */
function isInstanceNotFoundError(error: unknown): boolean {
  return error instanceof AzureDataPlaneError && error.status === 404;
}

/**
 * Finalize a candidate whose provider instance is gone. Mirrors the
 * not-running branch of the timed/heartbeat handlers: idle runs complete
 * without a snapshot; anything else fails (or cancels after a stop request).
 */
async function finalizeRunForMissingInstance(
  job: SleepCheckJob,
  path: SleepCheckPath,
): Promise<void> {
  const details = {
    path,
    decision: 'instance_not_found',
    ...buildSleepCheckDetails(job),
  };

  if (job.status === RunStatus.Idle) {
    await recordSleepCheckEvent(
      job,
      'decision',
      `${describeSleepCheckPath(path)} found that idle instance ${job.machineId} no longer exists; completing task run #${job.id} without a snapshot.`,
      details,
    );
    await completeIdleJobWithoutSnapshot(
      job,
      `Instance ${job.machineId} no longer exists.`,
      details,
    );
    return;
  }

  const finalStatus = await resolveSweptJobFinalStatus(job.id);

  await recordSleepCheckEvent(
    job,
    finalStatus === RunStatus.Canceled ? 'decision' : 'failed',
    `${describeSleepCheckPath(path)} found that instance ${job.machineId} no longer exists; finalizing task run #${job.id} as ${finalStatus}.`,
    details,
  );
  await finishRun({
    id: job.id,
    status: finalStatus,
    error: `${describeSleepCheckPath(path)} found that instance ${job.machineId} no longer exists`,
  });
}

async function handleTimedSleepCandidate(params: {
  job: SleepCheckJob;
  path: 'due_sleep' | 'hard_limit';
  status: string;
  timeoutRemainingMs: number | null | undefined;
  client: ReturnType<typeof createComputeProviderClient>;
}): Promise<{ snapshotted: number; shutDown: number; failed: number }> {
  const { job, path, status, timeoutRemainingMs, client } = params;
  const isResumable = isResumableSleepCandidate(job);
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

    if (job.status === RunStatus.Idle) {
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

    const finalStatus = await resolveSweptJobFinalStatus(job.id);

    await recordSleepCheckEvent(
      job,
      finalStatus === RunStatus.Canceled ? 'decision' : 'failed',
      finalStatus === RunStatus.Canceled
        ? `${describeSleepCheckPath(path)} found active instance ${job.machineId} in status ${status}; finalizing task run #${job.id} as canceled after its stop request.`
        : `${describeSleepCheckPath(path)} found active instance ${job.machineId} in status ${status}; failing the task run.`,
      details,
    );
    await finishRun({
      id: job.id,
      status: finalStatus,
      error: `${describeSleepCheckPath(path)} found active instance ${job.machineId} in status ${status}`,
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
        `[sleepCheck] Skipped stale active extension for task run #${job.id}: task no longer running`,
      );
      return { snapshotted: 0, shutDown: 0, failed: 0 };
    }

    await recordSleepCheckEvent(
      job,
      'decision',
      `Extended the sleep deadline for active task run #${job.id}.`,
      {
        path: 'due_sleep',
        decision: 'extend_active_deadline',
        nextSleepAt: nextSleepAt.toISOString(),
        timeoutRemainingMs,
        ...buildSleepCheckDetails(job),
      },
    );
    console.warn(
      `[sleepCheck] Extended stale active sleep deadline for task run #${job.id} to ${nextSleepAt.toISOString()}`,
    );
    return { snapshotted: 0, shutDown: 0, failed: 0 };
  }

  if (isResumable) {
    // Terminal cancels stamp cancelRequestedAt. They must destroy/finalize
    // rather than snapshot or enter standby, even on resume-capable providers.
    const stopRequestedStatus = await resolveSweptJobFinalStatus(job.id);
    if (stopRequestedStatus === RunStatus.Canceled) {
      await destroyInstanceWithAudit(
        job,
        client,
        {
          path,
          phase: 'destroy_and_cancel_after_stop_request',
          reason:
            path === 'hard_limit'
              ? 'provider_timeout_backstop'
              : 'due_sleep_shutdown',
        },
        'sleepCheck',
      );

      await finishRun({
        id: job.id,
        status: RunStatus.Canceled,
        error: `${describeSleepCheckPath(path)} destroyed instance ${job.machineId} after a terminal stop request`,
      });

      await recordSleepCheckEvent(
        job,
        'decision',
        `Destroyed instance ${job.machineId} and canceled task run #${job.id} after its stop request.`,
        {
          path,
          decision: 'destroy_and_cancel_after_stop_request',
          ...buildSleepCheckDetails(job),
        },
      );
      console.warn(
        `[sleepCheck] Destroyed instance and canceled task run #${job.id} after stop request`,
      );
      return { snapshotted: 0, shutDown: 1, failed: 0 };
    }

    const preserved = await claimResumableSleep(job, client, path);

    if (preserved) {
      console.log(
        isStandbyResumeCapableComputeProvider(job.vendor)
          ? `[sleepCheck] Retained standby for task run #${job.id}`
          : `[sleepCheck] Enqueued snapshot for task run #${job.id}`,
      );
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
    `Claimed the ${path === 'hard_limit' ? 'provider-timeout' : 'due'} non-resumable shutdown for task run #${job.id}.`,
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
        status: RunStatus.Completed,
        completedAt: endedAt,
      })
      .where(eq(taskRuns.id, job.id));

    // Direct-completion path (not via finishRun): derive the task state
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
        runId: job.id,
      });
    } catch (error) {
      console.warn(
        `[sleepCheck] Failed to refresh final title for task run #${job.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  await recordSleepCheckEvent(
    job,
    'completed',
    `Shut down instance ${job.machineId} for non-resumable task run #${job.id}${path === 'hard_limit' ? ' due to provider-timeout backstop' : ''}.`,
    {
      path,
      decision:
        path === 'hard_limit'
          ? 'complete_hard_limit_non_resumable_shutdown'
          : 'complete_non_resumable_shutdown',
      ...buildSleepCheckDetails(job),
    },
  );
  console.log(`[sleepCheck] Shut down instance for task run #${job.id}`);
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
      `Failed stale-worker task run #${jobId} because instance ${machineId} was ${status}.`,
    consoleMessage: (jobId, machineId, status) =>
      `[sleepCheck] Failed stale-worker task run #${jobId}: instance ${machineId} is ${status}`,
  },
  snapshottedConsoleMessage: (jobId) =>
    `[sleepCheck] Snapshotted stale-worker resumable task run #${jobId}`,
  destroyAndFail: {
    failureError: (machineId) =>
      `Worker heartbeat stale for instance ${machineId}`,
    eventMessage: (jobId, machineId) =>
      `Destroyed instance ${machineId} and failed non-resumable stale task run #${jobId}.`,
    consoleMessage: (jobId) =>
      `[sleepCheck] Destroyed instance and failed non-resumable stale task run #${jobId}`,
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
      `Failed booting task run #${jobId} because its first heartbeat never arrived and instance ${machineId} was ${status}.`,
    consoleMessage: (jobId, machineId, status) =>
      `[sleepCheck] Failed booting task run #${jobId}: initial heartbeat missing and instance ${machineId} is ${status}`,
  },
  snapshottedConsoleMessage: (jobId) =>
    `[sleepCheck] Snapshotted booting task run #${jobId} after missing initial heartbeat`,
  destroyAndFail: {
    failureError: (machineId) =>
      `Initial worker heartbeat missing for instance ${machineId}`,
    eventMessage: (jobId, machineId) =>
      `Destroyed instance ${machineId} and failed booting task run #${jobId} after the worker missed its initial heartbeat.`,
    consoleMessage: (jobId) =>
      `[sleepCheck] Destroyed instance and failed booting task run #${jobId} after missing initial heartbeat`,
  },
};

async function handleHeartbeatRecoveryCandidate(params: {
  job: SleepCheckJob;
  status: string;
  client: ReturnType<typeof createComputeProviderClient>;
  config: HeartbeatRecoveryConfig;
}): Promise<{ snapshotted: number; failed: number }> {
  const { job, status, client, config } = params;
  const isResumable = isResumableSleepCandidate(job);

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

    if (config.completeIdleInsteadOfFailing && job.status === RunStatus.Idle) {
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

    const finalStatus = await resolveSweptJobFinalStatus(job.id);

    await finishRun({
      id: job.id,
      status: finalStatus,
      error: config.notRunning.failureError(job.machineId, status),
    });

    if (finalStatus === RunStatus.Canceled) {
      await recordSleepCheckEvent(
        job,
        'decision',
        `Canceled task run #${job.id} after its stop request because instance ${job.machineId} was ${status}.`,
        details,
      );
      console.warn(
        `[sleepCheck] Canceled task run #${job.id} after stop request: instance ${job.machineId} is ${status}`,
      );
    } else {
      await recordSleepCheckEvent(
        job,
        'failed',
        config.notRunning.eventMessage(job.id, job.machineId, status),
        details,
      );
      console.warn(
        config.notRunning.consoleMessage(job.id, job.machineId, status),
      );
    }
    return { snapshotted: 0, failed: 1 };
  }

  if (isResumable) {
    // Terminal cancels stamp cancelRequestedAt. Never snapshot or standby them.
    const stopRequestedStatus = await resolveSweptJobFinalStatus(job.id);
    if (stopRequestedStatus === RunStatus.Canceled) {
      await destroyInstanceWithAudit(
        job,
        client,
        {
          path: config.path,
          phase: 'destroy_and_cancel_after_stop_request',
          reason: config.destroyReason,
        },
        'sleepCheck',
      );

      await finishRun({
        id: job.id,
        status: RunStatus.Canceled,
        error: config.destroyAndFail.failureError(job.machineId),
      });

      await recordSleepCheckEvent(
        job,
        'decision',
        `Destroyed instance ${job.machineId} and canceled task run #${job.id} after its stop request.`,
        {
          path: config.path,
          decision: 'destroy_and_cancel_after_stop_request',
          ...buildSleepCheckDetails(job),
        },
      );
      console.warn(
        `[sleepCheck] Destroyed instance and canceled task run #${job.id} after stop request`,
      );
      return { snapshotted: 0, failed: 0 };
    }

    const preserved = await claimResumableSleep(job, client, config.path);
    if (preserved) {
      console.warn(
        isStandbyResumeCapableComputeProvider(job.vendor)
          ? `[sleepCheck] Retained standby for ${describeSleepCheckPath(config.path).toLowerCase()} task run #${job.id}`
          : config.snapshottedConsoleMessage(job.id),
      );
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

  const finalStatus = await resolveSweptJobFinalStatus(job.id);

  await finishRun({
    id: job.id,
    status: finalStatus,
    error: config.destroyAndFail.failureError(job.machineId),
  });

  if (finalStatus === RunStatus.Canceled) {
    await recordSleepCheckEvent(
      job,
      'decision',
      `Destroyed instance ${job.machineId} and canceled task run #${job.id} after its stop request.`,
      {
        path: config.path,
        decision: 'destroy_and_cancel_after_stop_request',
        ...buildSleepCheckDetails(job),
      },
    );
    console.warn(
      `[sleepCheck] Destroyed instance and canceled task run #${job.id} after stop request`,
    );
  } else {
    await recordSleepCheckEvent(
      job,
      'failed',
      config.destroyAndFail.eventMessage(job.id, job.machineId),
      {
        path: config.path,
        decision: 'destroy_and_fail_non_resumable',
        ...buildSleepCheckDetails(job),
      },
    );
    console.warn(config.destroyAndFail.consoleMessage(job.id));
  }
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
        runId: job.id,
        taskRunStatus: job.status,
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

  // Serialize with the cancel-finalization teardown path: both destroyers
  // record their final usage row only after the provider call returns, so the
  // redis claim is the only atomic arbiter for a live race on this machine.
  // The lease renews until settled below, so a slow provider delete cannot
  // outlive it.
  const claim = await claimMachineDestroy({
    provider: job.vendor ?? 'docker',
    machineId: job.machineId!,
    owner: logPrefix,
  });

  if (claim.outcome === 'held') {
    console.log(
      `[${logPrefix}] Skipping destroyInstance for ${job.machineId}: another destroyer holds the teardown claim`,
    );
    return;
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

    // Success: stop renewing and let the claim expire naturally — the
    // residual TTL keeps guarding against a duplicate delete.
    claim.finish();

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
    // Give the claim back (token-conditional, so a successor that took over
    // after a lapsed lease is unaffected) so teardown can be retried.
    await claim.release();
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
    case 'manual_sleep':
      return 'Manual sleep handling';
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
    taskRunStatus: job.status,
    taskPhase: job.taskPhase ?? null,
    machineId: job.machineId ?? null,
    provider: job.vendor ?? null,
    startedAt: job.startedAt?.toISOString() ?? null,
    sleepAt: job.sleepAt?.toISOString() ?? null,
    sleepRequestedAt: job.sleepRequestedAt?.toISOString() ?? null,
    snapshotRequestedAt: job.snapshotRequestedAt?.toISOString() ?? null,
    workerHeartbeatAt: job.workerHeartbeatAt?.toISOString() ?? null,
    resumable: isResumableTaskPayloadKind(job.payloadKind),
    taskId: job.taskId,
  };
}

function buildSleepCheckCandidateDetails(
  candidates: SleepCheckCandidateSet,
  preferredPath: SleepCheckPath,
) {
  return {
    preferredPath,
    dueSleepRunId: candidates.dueJob?.id ?? null,
    hardLimitRunId: candidates.hardLimitJob?.id ?? null,
    bootingNoHeartbeatRunId: candidates.bootingNoHeartbeatJob?.id ?? null,
    staleWorkerRunId: candidates.staleWorkerJob?.id ?? null,
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
    `${describeSleepCheckPath(path)} found instance ${job.machineId} already snapshotting; leaving the task run alone.`,
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
    await recordTaskRunEvent(db, {
      runId: job.id,
      taskId: job.taskId,
      source: 'sleep_check',
      eventType,
      message,
      details,
    });
  } catch (error) {
    console.warn(
      `[sleepCheck] Failed to persist task run event for #${job.id}: ${
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
      `Skipped completing idle task run #${job.id} without a snapshot because another process already claimed it.`,
      { ...details, decision: 'skip_complete_without_snapshot_claim_lost' },
    );
    return;
  }

  await recordSleepCheckEvent(
    job,
    'decision',
    `Claimed idle completion without a snapshot for task run #${job.id}.`,
    {
      ...details,
      decision: 'claim_complete_without_snapshot',
      sleepRequestedAt: sleepRequestedAt.toISOString(),
      snapshotFailedAt: snapshotFailedAt.toISOString(),
    },
  );

  try {
    await finishRun({
      id: job.id,
      status: RunStatus.Completed,
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
    `Completed idle task run #${job.id} without a snapshot.`,
    {
      ...details,
      decision: 'complete_without_snapshot',
      snapshotFailedAt: snapshotFailedAt.toISOString(),
      error: errorMessage,
    },
  );
}
