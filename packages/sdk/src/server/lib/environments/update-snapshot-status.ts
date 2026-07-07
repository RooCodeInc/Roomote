import {
  type JobTokenContext,
  CloudTaskType,
  resolveComputeProviderTarget,
} from '@roomote/types';
import {
  db,
  cloudJobs,
  environments,
  buildPendingEnvironmentSnapshotMatchForCloudJob,
  getEnvironmentSnapshot,
  updatePendingEnvironmentSnapshot,
  eq,
} from '@roomote/db/server';

interface UpdateSnapshotStatusInput {
  environmentId: string;
  snapshotStatus: 'failed';
}

export async function updateSnapshotStatus(
  auth: JobTokenContext,
  input: UpdateSnapshotStatusInput,
): Promise<void> {
  const cloudJob = await db.query.cloudJobs.findFirst({
    where: eq(cloudJobs.id, auth.cloudJobId),
  });

  const jobEnvironmentId = cloudJob?.payload.environmentId;
  const isValidSnapshotJob =
    cloudJob?.type === CloudTaskType.SnapshotEnvironment &&
    typeof jobEnvironmentId === 'string' &&
    jobEnvironmentId === input.environmentId;

  if (!isValidSnapshotJob) {
    throw new Error(
      '[updateSnapshotStatus] Job token does not own this snapshot environment',
    );
  }

  const provider = resolveComputeProviderTarget(cloudJob.vendor);
  const pendingSnapshotMatch =
    buildPendingEnvironmentSnapshotMatchForCloudJob(cloudJob);
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
