import {
  type RunTokenContext,
  TaskPayloadKind,
  resolveComputeProviderTarget,
} from '@roomote/types';
import {
  db,
  taskRuns,
  environments,
  buildPendingEnvironmentSnapshotMatchForTaskRun,
  getEnvironmentSnapshot,
  updatePendingEnvironmentSnapshot,
  eq,
} from '@roomote/db/server';

interface UpdateSnapshotStatusInput {
  environmentId: string;
  snapshotStatus: 'failed';
}

export async function updateSnapshotStatus(
  auth: RunTokenContext,
  input: UpdateSnapshotStatusInput,
): Promise<void> {
  const taskRun = await db.query.taskRuns.findFirst({
    where: eq(taskRuns.id, auth.runId),
  });

  const jobEnvironmentId = taskRun?.payload.environmentId;
  const isValidSnapshotRun =
    taskRun?.payloadKind === TaskPayloadKind.SnapshotEnvironment &&
    typeof jobEnvironmentId === 'string' &&
    jobEnvironmentId === input.environmentId;

  if (!isValidSnapshotRun) {
    throw new Error(
      '[updateSnapshotStatus] Run token does not own this snapshot environment',
    );
  }

  const provider = resolveComputeProviderTarget(taskRun.vendor);
  const pendingSnapshotMatch =
    buildPendingEnvironmentSnapshotMatchForTaskRun(taskRun);
  const updated = await updatePendingEnvironmentSnapshot(db, {
    environmentId: input.environmentId,
    provider,
    snapshotId: null,
    snapshotStatus: input.snapshotStatus,
    snapshotCreatedAt: null,
    snapshotExpiresAt: null,
    ...pendingSnapshotMatch,
  });

  if (updated) {
    return;
  }

  const environment = await db.query.environments.findFirst({
    where: eq(environments.id, input.environmentId),
    columns: {
      snapshotId: true,
      snapshotStatus: true,
      snapshotCreatedAt: true,
      snapshotExpiresAt: true,
    },
  });

  if (environment) {
    const snapshot = await getEnvironmentSnapshot({
      environmentId: input.environmentId,
      provider,
    });

    if (snapshot?.snapshotStatus === input.snapshotStatus) {
      return;
    }
  }

  throw new Error(
    '[updateSnapshotStatus] Snapshot status can only be updated from pending',
  );
}
