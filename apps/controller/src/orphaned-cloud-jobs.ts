import {
  RunStatus,
  ORPHANED_AFTER_DEQUEUE_THRESHOLD_MS,
  ORPHANED_PENDING_THRESHOLD_MS,
} from '@roomote/types';
import { type Run, db, taskRuns, eq, sql } from '@roomote/db/server';
import { releaseCloudTask } from '@roomote/cloud-agents/server';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/**
 * Claims one stale run in PostgreSQL before returning it to the controller.
 *
 * `FOR UPDATE SKIP LOCKED` is the cross-process suppression mechanism: two
 * controllers cannot recover the same row, and refreshing `dequeued_at`
 * persists the recovery lease after the transaction releases its row lock.
 */
async function claimOrphanedJob(): Promise<Run | null> {
  return db.transaction(async (tx) => {
    const [claimed] = await tx.execute<Pick<Run, 'id'>>(sql`
      WITH candidate AS (
        SELECT id
        FROM task_runs
        WHERE (
          (
            status = ${RunStatus.Pending}
            AND created_at < NOW() - (${ORPHANED_PENDING_THRESHOLD_MS} * INTERVAL '1 millisecond')
            AND created_at > NOW() - (${24 * HOUR} * INTERVAL '1 millisecond')
          )
          OR
          (
            status = ${RunStatus.Dequeued}
            AND dequeued_at < NOW() - (${ORPHANED_AFTER_DEQUEUE_THRESHOLD_MS} * INTERVAL '1 millisecond')
          )
        )
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE task_runs
      SET status = ${RunStatus.Dequeued}, dequeued_at = NOW()
      FROM candidate
      WHERE task_runs.id = candidate.id
      RETURNING task_runs.id
    `);

    if (!claimed) {
      return null;
    }

    return (
      (await tx.query.taskRuns.findFirst({
        where: eq(taskRuns.id, claimed.id),
      })) ?? null
    );
  });
}

export const getOrphanedJob = async (): Promise<Run | null> => {
  const cloudJob = await claimOrphanedJob();

  if (!cloudJob) {
    return null;
  }

  console.warn(`[getOrphanedJob] Recovering orphaned job #${cloudJob.id}`, {
    payloadKind: cloudJob.payloadKind,
    repo: cloudJob.payload.repo,
    status: cloudJob.status,
    createdAgeMinutes: (
      (Date.now() - cloudJob.createdAt.getTime()) /
      MINUTE
    ).toFixed(0),
    reason: 'persisted queue lease exceeded its recovery threshold',
  });

  // A stale dequeue may still own its old Redis lock. Owner-checked release
  // cannot delete a newer run's lock even when both runs share a scope.
  await releaseCloudTask(cloudJob);

  return cloudJob;
};
