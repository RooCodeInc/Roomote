import {
  RunStatus,
  ORPHANED_AFTER_DEQUEUE_THRESHOLD_MS,
  ORPHANED_PENDING_THRESHOLD_MS,
} from '@roomote/types';
import { type TaskRun, db, taskRuns, eq, sql } from '@roomote/db/server';
import { releaseTaskRun } from '@roomote/cloud-agents/server';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/**
 * Claims one stale task run in PostgreSQL before returning it to the
 * controller. `FOR UPDATE SKIP LOCKED` prevents two controllers from
 * recovering the same run, while refreshing `dequeued_at` persists the
 * recovery lease after the transaction releases its row lock.
 */
async function claimOrphanedTaskRun(): Promise<TaskRun | null> {
  return db.transaction(async (tx) => {
    const [claimed] = await tx.execute<Pick<TaskRun, 'id'>>(sql`
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

export const getOrphanedTaskRun = async (): Promise<TaskRun | null> => {
  const taskRun = await claimOrphanedTaskRun();

  if (!taskRun) {
    return null;
  }

  console.warn(
    `[getOrphanedTaskRun] Recovering orphaned task run #${taskRun.id}`,
    {
      payloadKind: taskRun.payloadKind,
      repo: taskRun.payload.repo,
      status: taskRun.status,
      createdAgeMinutes: (
        (Date.now() - taskRun.createdAt.getTime()) /
        MINUTE
      ).toFixed(0),
      reason: 'persisted queue lease exceeded its recovery threshold',
    },
  );

  // A stale dequeue may still own its old Redis lock. Owner-checked release
  // cannot delete a newer run's lock even when both runs share a scope.
  await releaseTaskRun(taskRun);

  return taskRun;
};
