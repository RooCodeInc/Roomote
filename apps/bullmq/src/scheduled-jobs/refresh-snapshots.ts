import {
  type ComputeProvider,
  type SnapshotEnvironmentAttachment,
  activeRunStatuses,
  TaskPayloadKind,
  resolveComputeProviderTarget,
} from '@roomote/types';
import {
  db,
  type DatabaseOrTransaction,
  environmentSnapshots,
  taskRuns,
  tasks,
  claimPendingEnvironmentSnapshotForAttachment,
  resolveDefaultComputeProvider,
  updatePendingEnvironmentSnapshot,
  withEnvironmentSnapshotLock,
  desc,
  eq,
  and,
  inArray,
  isNull,
  sql,
} from '@roomote/db/server';
import { enqueueTask } from '@roomote/cloud-agents/server';

const SNAPSHOT_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PENDING_SNAPSHOT_RECOVERY_GRACE_MS = 5 * 60 * 1000;
const LOG_PREFIX = '[refreshSnapshots]';

interface SnapshotRefreshCandidateBase {
  environmentId: string;
  environmentName: string;
  provider: ComputeProvider;
  snapshotId: string | null;
  snapshotCreatedAt: Date | null;
  snapshotExpiresAt: Date | null;
  updatedAt: Date | null;
}

type SnapshotRefreshCandidate =
  | (SnapshotRefreshCandidateBase & {
      source: 'environment_snapshot_row';
      snapshotId: string;
      environmentSnapshotId: string;
    })
  | (SnapshotRefreshCandidateBase & {
      source: 'missing_default_provider_snapshot';
    });

interface SnapshotRefreshDiscoveryResult {
  candidates: SnapshotRefreshCandidate[];
  discovery: {
    targetProvider: ComputeProvider;
    targetProviderSnapshotRowCount: number;
    readyTargetProviderCandidateCount: number;
    missingTargetProviderCandidateCount: number;
  };
}

interface ActiveSnapshotRefreshJob {
  id: number;
  status: string;
  createdAt: Date;
}

type SnapshotRefreshLockResult =
  | {
      kind: 'active_refresh';
      activeRefreshJob: ActiveSnapshotRefreshJob;
    }
  | { kind: 'skipped' }
  | {
      kind: 'enqueued';
      cloudJobId: number;
    };

function logRefreshSnapshots(
  message: string,
  details?: Record<string, unknown>,
): void {
  if (details) {
    console.log(`${LOG_PREFIX} ${message}`, details);
    return;
  }

  console.log(`${LOG_PREFIX} ${message}`);
}

function logRefreshSnapshotsError(
  message: string,
  details?: Record<string, unknown>,
): void {
  if (details) {
    console.error(`${LOG_PREFIX} ${message}`, details);
    return;
  }

  console.error(`${LOG_PREFIX} ${message}`);
}

function summarizeCandidatesByProvider(
  candidates: SnapshotRefreshCandidate[],
): Record<string, number> {
  return candidates.reduce<Record<string, number>>((counts, candidate) => {
    counts[candidate.provider] = (counts[candidate.provider] ?? 0) + 1;
    return counts;
  }, {});
}

function getSnapshotAgeHours(
  snapshotCreatedAt: Date | null,
  now: Date,
): number | null {
  if (!snapshotCreatedAt) {
    return null;
  }

  return Number(
    ((now.getTime() - snapshotCreatedAt.getTime()) / (60 * 60 * 1000)).toFixed(
      2,
    ),
  );
}

function hasReadySnapshot(snapshot: {
  snapshotId: string | null;
  snapshotStatus: string | null;
}): boolean {
  return snapshot.snapshotId != null && snapshot.snapshotStatus === 'ready';
}

function isSnapshotDueForRefresh(
  snapshotCreatedAt: Date | null,
  cutoff: Date,
): boolean {
  return snapshotCreatedAt == null || snapshotCreatedAt < cutoff;
}

function isPendingSnapshotWithinRecoveryGrace(
  updatedAt: Date | null,
  now: Date,
): boolean {
  return (
    updatedAt != null &&
    updatedAt.getTime() >= now.getTime() - PENDING_SNAPSHOT_RECOVERY_GRACE_MS
  );
}

type SnapshotRefreshAttachmentCandidate = Exclude<
  SnapshotRefreshCandidate,
  { source: 'missing_default_provider_snapshot' }
>;

function buildSnapshotRefreshAttachment(
  candidate: SnapshotRefreshAttachmentCandidate,
): SnapshotEnvironmentAttachment {
  return {
    source: 'active_snapshot_row',
    environmentSnapshotId: candidate.environmentSnapshotId,
    sourceSnapshotId: candidate.snapshotId,
    sourceSnapshotCreatedAt: candidate.snapshotCreatedAt?.toISOString() ?? null,
  };
}

async function findSnapshotRefreshCandidates(
  cutoff: Date,
): Promise<SnapshotRefreshDiscoveryResult> {
  const now = new Date();
  const targetProvider = resolveComputeProviderTarget(
    await resolveDefaultComputeProvider(),
  );
  const snapshotRows = await db.query.environmentSnapshots.findMany({
    where: and(
      eq(environmentSnapshots.provider, targetProvider),
      isNull(environmentSnapshots.deletedAt),
    ),
    columns: {
      id: true,
      environmentId: true,
      provider: true,
      snapshotId: true,
      snapshotStatus: true,
      snapshotCreatedAt: true,
      snapshotExpiresAt: true,
      updatedAt: true,
    },
  });
  const rawEnvironments = await db.query.environments.findMany({
    columns: {
      id: true,
      name: true,
      updatedAt: true,
    },
  });

  const candidates: SnapshotRefreshCandidate[] = [];
  const snapshotRowByEnvironmentId = new Map(
    snapshotRows.map((snapshotRow) => [snapshotRow.environmentId, snapshotRow]),
  );
  let readyTargetProviderCandidateCount = 0;
  let missingTargetProviderCandidateCount = 0;

  for (const environment of rawEnvironments) {
    const snapshotRow = snapshotRowByEnvironmentId.get(environment.id);

    if (snapshotRow) {
      if (
        snapshotRow.snapshotStatus === 'pending' &&
        isPendingSnapshotWithinRecoveryGrace(snapshotRow.updatedAt, now)
      ) {
        continue;
      }

      if (
        hasReadySnapshot(snapshotRow) &&
        isSnapshotDueForRefresh(snapshotRow.snapshotCreatedAt, cutoff)
      ) {
        readyTargetProviderCandidateCount++;
        if (!snapshotRow.snapshotId) {
          continue;
        }
        candidates.push({
          environmentId: environment.id,
          environmentName: environment.name,
          provider: snapshotRow.provider,
          environmentSnapshotId: snapshotRow.id,
          snapshotId: snapshotRow.snapshotId,
          snapshotCreatedAt: snapshotRow.snapshotCreatedAt,
          snapshotExpiresAt: snapshotRow.snapshotExpiresAt,
          updatedAt: snapshotRow.updatedAt,
          source: 'environment_snapshot_row',
        });
      } else if (!hasReadySnapshot(snapshotRow)) {
        missingTargetProviderCandidateCount++;
        candidates.push({
          environmentId: environment.id,
          environmentName: environment.name,
          provider: targetProvider,
          snapshotId: snapshotRow.snapshotId,
          snapshotCreatedAt: snapshotRow.snapshotCreatedAt,
          snapshotExpiresAt: snapshotRow.snapshotExpiresAt,
          updatedAt: snapshotRow.updatedAt,
          source: 'missing_default_provider_snapshot',
        });
      }

      continue;
    }

    missingTargetProviderCandidateCount++;
    candidates.push({
      environmentId: environment.id,
      environmentName: environment.name,
      provider: targetProvider,
      snapshotId: null,
      snapshotCreatedAt: null,
      snapshotExpiresAt: null,
      updatedAt: environment.updatedAt,
      source: 'missing_default_provider_snapshot',
    });
  }

  return {
    candidates,
    discovery: {
      targetProvider,
      targetProviderSnapshotRowCount: snapshotRows.length,
      readyTargetProviderCandidateCount,
      missingTargetProviderCandidateCount,
    },
  };
}

async function findActiveSnapshotRefreshJob(
  candidate: SnapshotRefreshCandidate,
  dbOrTx: DatabaseOrTransaction = db,
): Promise<ActiveSnapshotRefreshJob | null> {
  const [activeRun] = await dbOrTx
    .select({
      id: taskRuns.id,
      status: taskRuns.status,
      createdAt: taskRuns.createdAt,
    })
    .from(taskRuns)
    .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .where(
      and(
        eq(tasks.workflow, 'env_snapshot'),
        eq(taskRuns.vendor, candidate.provider),
        inArray(taskRuns.status, [...activeRunStatuses]),
        sql`${taskRuns.payload}->>'environmentId' = ${candidate.environmentId}`,
      ),
    )
    .orderBy(desc(taskRuns.createdAt), desc(taskRuns.id))
    .limit(1);

  return activeRun ?? null;
}

async function hasRecentPendingSnapshotClaim(
  candidate: SnapshotRefreshCandidate,
  now: Date,
  dbOrTx: DatabaseOrTransaction = db,
): Promise<boolean> {
  const providerSnapshot = await dbOrTx.query.environmentSnapshots.findFirst({
    where: and(
      eq(environmentSnapshots.environmentId, candidate.environmentId),
      eq(environmentSnapshots.provider, candidate.provider),
      isNull(environmentSnapshots.deletedAt),
    ),
    columns: {
      snapshotStatus: true,
      updatedAt: true,
    },
  });

  if (
    providerSnapshot?.snapshotStatus === 'pending' &&
    isPendingSnapshotWithinRecoveryGrace(providerSnapshot.updatedAt, now)
  ) {
    return true;
  }

  return false;
}

/**
 * Refresh ready snapshots for the default compute provider every day and
 * create one when an environment does not have a ready snapshot yet.
 *
 * The refresh keeps the current snapshot in place until the replacement
 * snapshot is created successfully. That way a failed refresh does not
 * clear the last known-good environment snapshot.
 */
export const refreshSnapshotsJob = async () => {
  const startedAt = new Date();
  logRefreshSnapshots('Starting snapshot refresh check', {
    startedAt: startedAt.toISOString(),
    refreshIntervalHours: SNAPSHOT_REFRESH_INTERVAL_MS / (60 * 60 * 1000),
  });

  try {
    const cutoff = new Date(startedAt.getTime() - SNAPSHOT_REFRESH_INTERVAL_MS);
    const { candidates: refreshCandidates, discovery } =
      await findSnapshotRefreshCandidates(cutoff);

    logRefreshSnapshots('Found environments due for snapshot maintenance', {
      cutoff: cutoff.toISOString(),
      candidateCount: refreshCandidates.length,
      candidatesByProvider: summarizeCandidatesByProvider(refreshCandidates),
      targetProvider: discovery.targetProvider,
      targetProviderSnapshotRowCount: discovery.targetProviderSnapshotRowCount,
      readyTargetProviderCandidateCount:
        discovery.readyTargetProviderCandidateCount,
      missingTargetProviderCandidateCount:
        discovery.missingTargetProviderCandidateCount,
    });

    let refreshed = 0;
    let skippedActiveRefreshCount = 0;
    const errors: Array<Record<string, unknown>> = [];
    for (const candidate of refreshCandidates) {
      const snapshotAgeHours = getSnapshotAgeHours(
        candidate.snapshotCreatedAt,
        startedAt,
      );
      let pendingSnapshotClaim: Awaited<
        ReturnType<typeof claimPendingEnvironmentSnapshotForAttachment>
      > = null;

      try {
        if (candidate.source === 'missing_default_provider_snapshot') {
          const activeRefreshJob =
            await findActiveSnapshotRefreshJob(candidate);

          if (activeRefreshJob) {
            skippedActiveRefreshCount++;
            logRefreshSnapshots(
              'Skipping snapshot refresh because one is already in flight',
              {
                environmentId: candidate.environmentId,
                environmentName: candidate.environmentName,
                provider: candidate.provider,
                source: candidate.source,
                snapshotId: candidate.snapshotId,
                snapshotCreatedAt:
                  candidate.snapshotCreatedAt?.toISOString() ?? null,
                snapshotExpiresAt:
                  candidate.snapshotExpiresAt?.toISOString() ?? null,
                snapshotUpdatedAt: candidate.updatedAt?.toISOString() ?? null,
                snapshotAgeHours,
                activeCloudJobId: activeRefreshJob.id,
                activeCloudJobStatus: activeRefreshJob.status,
                activeCloudJobCreatedAt:
                  activeRefreshJob.createdAt.toISOString(),
              },
            );
            continue;
          }

          if (await hasRecentPendingSnapshotClaim(candidate, new Date())) {
            continue;
          }

          pendingSnapshotClaim =
            await claimPendingEnvironmentSnapshotForAttachment(db, {
              environmentId: candidate.environmentId,
              provider: candidate.provider,
              updatedAt: startedAt,
              allowStalePendingBefore: new Date(
                startedAt.getTime() - PENDING_SNAPSHOT_RECOVERY_GRACE_MS,
              ),
              requireMissingSnapshot: true,
            });

          if (!pendingSnapshotClaim) {
            continue;
          }

          logRefreshSnapshots('Queueing snapshot refresh job', {
            environmentId: candidate.environmentId,
            environmentName: candidate.environmentName,
            provider: candidate.provider,
            source: candidate.source,
            snapshotId: candidate.snapshotId,
            snapshotCreatedAt:
              candidate.snapshotCreatedAt?.toISOString() ?? null,
            snapshotExpiresAt:
              candidate.snapshotExpiresAt?.toISOString() ?? null,
            snapshotUpdatedAt: candidate.updatedAt?.toISOString() ?? null,
            snapshotAgeHours,
          });

          const { id } = await enqueueTask({
            task: {
              type: TaskPayloadKind.SnapshotEnvironment,
              computeProvider: candidate.provider,
              payload: {
                repo: '',
                environmentId: candidate.environmentId,
                environmentSnapshotAttachment:
                  pendingSnapshotClaim.attachmentSource,
              },
            },
            initiator: { kind: 'automation', key: 'snapshot_refresh' },
            workflow: 'env_snapshot',
            surface: 'system',
            trigger: 'schedule',
            visibility: 'hidden',
          });

          logRefreshSnapshots('Created snapshot refresh job', {
            cloudJobId: id,
            environmentId: candidate.environmentId,
            environmentName: candidate.environmentName,
            provider: candidate.provider,
            source: candidate.source,
            snapshotId: candidate.snapshotId,
            snapshotAgeHours,
          });

          refreshed++;
          continue;
        }

        const lockResult = await withEnvironmentSnapshotLock(
          db,
          {
            environmentId: candidate.environmentId,
            provider: candidate.provider,
          },
          async (tx) => {
            const activeRefreshJob = await findActiveSnapshotRefreshJob(
              candidate,
              tx,
            );

            if (activeRefreshJob) {
              return {
                kind: 'active_refresh',
                activeRefreshJob,
              } satisfies SnapshotRefreshLockResult;
            }

            if (
              await hasRecentPendingSnapshotClaim(candidate, new Date(), tx)
            ) {
              return { kind: 'skipped' } satisfies SnapshotRefreshLockResult;
            }

            logRefreshSnapshots('Queueing snapshot refresh job', {
              environmentId: candidate.environmentId,
              environmentName: candidate.environmentName,
              provider: candidate.provider,
              source: candidate.source,
              snapshotId: candidate.snapshotId,
              snapshotCreatedAt:
                candidate.snapshotCreatedAt?.toISOString() ?? null,
              snapshotExpiresAt:
                candidate.snapshotExpiresAt?.toISOString() ?? null,
              snapshotUpdatedAt: candidate.updatedAt?.toISOString() ?? null,
              snapshotAgeHours,
            });

            const { id } = await enqueueTask({
              task: {
                type: TaskPayloadKind.SnapshotEnvironment,
                computeProvider: candidate.provider,
                payload: {
                  repo: '',
                  environmentId: candidate.environmentId,
                  environmentSnapshotAttachment:
                    buildSnapshotRefreshAttachment(candidate),
                },
              },
              initiator: { kind: 'automation', key: 'snapshot_refresh' },
              workflow: 'env_snapshot',
              surface: 'system',
              trigger: 'schedule',
              visibility: 'hidden',
            });

            return {
              kind: 'enqueued',
              cloudJobId: id,
            } satisfies SnapshotRefreshLockResult;
          },
        );

        if (lockResult.kind === 'active_refresh') {
          skippedActiveRefreshCount++;
          logRefreshSnapshots(
            'Skipping snapshot refresh because one is already in flight',
            {
              environmentId: candidate.environmentId,
              environmentName: candidate.environmentName,
              provider: candidate.provider,
              source: candidate.source,
              snapshotId: candidate.snapshotId,
              snapshotCreatedAt:
                candidate.snapshotCreatedAt?.toISOString() ?? null,
              snapshotExpiresAt:
                candidate.snapshotExpiresAt?.toISOString() ?? null,
              snapshotUpdatedAt: candidate.updatedAt?.toISOString() ?? null,
              snapshotAgeHours,
              activeCloudJobId: lockResult.activeRefreshJob.id,
              activeCloudJobStatus: lockResult.activeRefreshJob.status,
              activeCloudJobCreatedAt:
                lockResult.activeRefreshJob.createdAt.toISOString(),
            },
          );
          continue;
        }

        if (lockResult.kind === 'skipped') {
          continue;
        }
        logRefreshSnapshots('Created snapshot refresh job', {
          cloudJobId: lockResult.cloudJobId,
          environmentId: candidate.environmentId,
          environmentName: candidate.environmentName,
          provider: candidate.provider,
          source: candidate.source,
          snapshotId: candidate.snapshotId,
          snapshotAgeHours,
        });

        refreshed++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (pendingSnapshotClaim) {
          try {
            const activeRefreshJobAfterError =
              await findActiveSnapshotRefreshJob(candidate);

            if (!activeRefreshJobAfterError) {
              await updatePendingEnvironmentSnapshot(db, {
                environmentId: candidate.environmentId,
                provider: candidate.provider,
                snapshotId: null,
                snapshotStatus: 'failed',
                snapshotCreatedAt: null,
                snapshotExpiresAt: null,
                attachmentSource: pendingSnapshotClaim.attachmentSource,
              });
            }
          } catch (statusError) {
            logRefreshSnapshotsError(
              'Failed to record snapshot backfill failure state',
              {
                environmentId: candidate.environmentId,
                provider: candidate.provider,
                error:
                  statusError instanceof Error
                    ? statusError.message
                    : String(statusError),
              },
            );
          }
        }

        const errorDetails = {
          environmentId: candidate.environmentId,
          environmentName: candidate.environmentName,
          provider: candidate.provider,
          source: candidate.source,
          snapshotId: candidate.snapshotId,
          snapshotCreatedAt: candidate.snapshotCreatedAt?.toISOString() ?? null,
          snapshotExpiresAt: candidate.snapshotExpiresAt?.toISOString() ?? null,
          snapshotUpdatedAt: candidate.updatedAt?.toISOString() ?? null,
          snapshotAgeHours,
          error: message,
        };
        errors.push(errorDetails);

        logRefreshSnapshotsError('Failed to refresh environment snapshot', {
          ...errorDetails,
          stack: error instanceof Error ? error.stack : null,
        });
      }
    }

    logRefreshSnapshots('Completed snapshot refresh check', {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      candidateCount: refreshCandidates.length,
      refreshedCount: refreshed,
      skippedActiveRefreshCount,
      errorCount: errors.length,
      candidatesByProvider: summarizeCandidatesByProvider(refreshCandidates),
    });

    if (errors.length > 0) {
      logRefreshSnapshotsError('Snapshot refresh errors', {
        errorCount: errors.length,
        errors,
      });
    }
  } catch (error) {
    logRefreshSnapshotsError('Snapshot refresh job failed', {
      startedAt: startedAt.toISOString(),
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
    });
    throw error;
  }
};
