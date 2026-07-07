import {
  db,
  cloudJobs,
  eq,
  and,
  gt,
  inArray,
  isNull,
  isNotNull,
  desc,
} from '@roomote/db/server';
import { CloudTaskStatus, SANDBOX_SNAPSHOT_EXPIRY_MS } from '@roomote/types';

import { slackDebug } from './logging';

/**
 * Find the most recent completed/idle cloud job for a Slack thread that has
 * a valid snapshot. Used to determine whether a follow-up message can resume
 * from a previous sandbox snapshot instead of starting fresh.
 *
 * Matches by slackThreadTs which is stable within a single Slack thread.
 *
 * Returns the job row needed to construct a SnapshotResume task, or null if
 * no suitable job exists.
 */
export async function findCompletedSlackJobWithSnapshot(slackThreadTs: string) {
  slackDebug(
    `[findCompletedSlackJobWithSnapshot] Searching for completed job with snapshot for thread ${slackThreadTs}`,
  );

  // Only consider snapshots that haven't expired yet (7-day TTL).
  const snapshotCutoff = new Date(Date.now() - SANDBOX_SNAPSHOT_EXPIRY_MS);

  const completedJob = await db.query.cloudJobs.findFirst({
    where: and(
      eq(cloudJobs.slackThreadTs, slackThreadTs),
      inArray(cloudJobs.status, [
        CloudTaskStatus.Completed,
        CloudTaskStatus.Idle,
      ]),
      isNotNull(cloudJobs.snapshotId),
      isNull(cloudJobs.snapshotFailedAt),
      isNull(cloudJobs.canceledAt),
      gt(cloudJobs.snapshotCreatedAt, snapshotCutoff),
    ),
    orderBy: desc(cloudJobs.createdAt),
    columns: {
      id: true,
      taskId: true,
      snapshotId: true,
      userId: true,
      payload: true,
      port: true,
      slackThreadTs: true,
      result: true,
    },
  });

  if (completedJob) {
    slackDebug(
      `[findCompletedSlackJobWithSnapshot] Found completed job ${completedJob.id} with snapshot ${completedJob.snapshotId}`,
    );
    return completedJob;
  }

  slackDebug(
    `[findCompletedSlackJobWithSnapshot] No completed job with snapshot found for thread ${slackThreadTs}`,
  );
  return null;
}
