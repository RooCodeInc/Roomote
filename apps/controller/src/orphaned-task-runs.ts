import {
  RunStatus,
  ORPHANED_AFTER_DEQUEUE_THRESHOLD_MS,
  ORPHANED_PENDING_THRESHOLD_MS,
} from '@roomote/types';
import { db, taskRuns, eq, and, gt, lt, asc } from '@roomote/db/server';
import { releaseTaskRun } from '@roomote/cloud-agents/server';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const ORPHAN_RETRY_DEDUPE_WINDOW_MS = ORPHANED_AFTER_DEQUEUE_THRESHOLD_MS;
const ORPHANED_AFTER_DEQUEUE_THRESHOLD_MINUTES = Math.ceil(
  ORPHANED_AFTER_DEQUEUE_THRESHOLD_MS / MINUTE,
);

const orphanMap = new Map<number, number>();

const getOrphanedBeforeDequeueRuns = () =>
  db.query.taskRuns.findMany({
    where: and(
      eq(taskRuns.status, RunStatus.Pending),
      lt(
        taskRuns.createdAt,
        new Date(Date.now() - ORPHANED_PENDING_THRESHOLD_MS),
      ),
      gt(taskRuns.createdAt, new Date(Date.now() - 24 * HOUR)),
    ),
    orderBy: [asc(taskRuns.createdAt)],
  });

const getOrphanedAfterDequeueRuns = () =>
  db.query.taskRuns.findMany({
    where: and(
      eq(taskRuns.status, RunStatus.Dequeued),
      lt(
        taskRuns.dequeuedAt,
        new Date(Date.now() - ORPHANED_AFTER_DEQUEUE_THRESHOLD_MS),
      ),
    ),
    orderBy: [asc(taskRuns.createdAt)],
  });

export const getOrphanedTaskRun = async () => {
  const orphanedRuns = (
    await Promise.all([
      getOrphanedBeforeDequeueRuns(),
      getOrphanedAfterDequeueRuns(),
    ])
  ).flat();

  for (let i = 0; i < orphanedRuns.length; i++) {
    const taskRun = orphanedRuns[i];

    if (!taskRun) {
      continue;
    }

    const ageMinutes = taskRun.dequeuedAt
      ? ((Date.now() - taskRun.dequeuedAt.getTime()) / 60_000).toFixed(0)
      : ((Date.now() - taskRun.createdAt.getTime()) / 60_000).toFixed(0);

    const ageLabel = taskRun.dequeuedAt ? 'dequeuedAt' : 'createdAt';

    console.log(
      `[getOrphanedTaskRun] id=${taskRun.id}, payloadKind=${taskRun.payloadKind}, repo=${taskRun.payload.repo}, ${ageLabel}=${ageMinutes}m ago`,
    );
  }

  const now = Date.now();

  for (const [runId, timestamp] of orphanMap.entries()) {
    if (now - timestamp > ORPHAN_RETRY_DEDUPE_WINDOW_MS) {
      orphanMap.delete(runId);
    }
  }

  const taskRun = orphanedRuns.find((run) => !orphanMap.has(run.id));

  if (taskRun) {
    orphanMap.set(taskRun.id, now);

    console.warn(
      `[getOrphanedTaskRun] Recovering orphaned task run #${taskRun.id}`,
      {
        payloadKind: taskRun.payloadKind,
        repo: taskRun.payload.repo,
        status: taskRun.status,
        reason: taskRun.dequeuedAt
          ? `dequeued for more than ${ORPHANED_AFTER_DEQUEUE_THRESHOLD_MINUTES} minutes without starting`
          : `pending for more than ${ORPHANED_PENDING_THRESHOLD_MS / MINUTE} minutes`,
      },
    );

    // Release the lock and clear dequeuedAt before returning.
    await releaseTaskRun(taskRun);

    await db
      .update(taskRuns)
      .set({ dequeuedAt: null })
      .where(eq(taskRuns.id, taskRun.id));
  }

  return taskRun;
};
