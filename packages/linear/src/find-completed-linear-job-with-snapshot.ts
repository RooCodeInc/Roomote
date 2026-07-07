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

/**
 * Find the most recent completed/idle cloud job for a Linear issue that has
 * a valid snapshot. Used to determine whether a follow-up message can resume
 * from a previous sandbox snapshot instead of starting fresh.
 *
 * Matches by issue ID rather than session ID because Linear creates a new
 * session for each agent mention, even on the same issue.
 *
 * Returns the job row needed to construct a SnapshotResume task, or null if
 * no suitable job exists.
 */
export async function findCompletedLinearJobWithSnapshot(
  linearIssueId: string,
) {
  console.log(
    `[findCompletedLinearJobWithSnapshot] Searching for completed job with snapshot for issue ${linearIssueId}`,
  );

  // Only consider snapshots that haven't expired yet (7-day TTL).
  const snapshotCutoff = new Date(Date.now() - SANDBOX_SNAPSHOT_EXPIRY_MS);

  const completedJob = await db.query.cloudJobs.findFirst({
    where: and(
      eq(cloudJobs.linearIssueId, linearIssueId),
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
      slackThreadTs: true,
      payload: true,
      port: true,
      result: true,
    },
  });

  if (completedJob) {
    console.log(
      `[findCompletedLinearJobWithSnapshot] Found completed job ${completedJob.id} with snapshot ${completedJob.snapshotId}`,
    );
    return completedJob;
  }

  console.log(
    `[findCompletedLinearJobWithSnapshot] No completed job with snapshot found for issue ${linearIssueId}`,
  );
  return null;
}
