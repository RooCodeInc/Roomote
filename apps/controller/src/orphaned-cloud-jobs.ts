import {
  CloudTaskStatus,
  ORPHANED_AFTER_DEQUEUE_THRESHOLD_MS,
  ORPHANED_PENDING_THRESHOLD_MS,
} from '@roomote/types';
import { db, taskRuns, eq, and, gt, lt, asc } from '@roomote/db/server';
import { releaseCloudTask } from '@roomote/cloud-agents/server';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const ORPHAN_RETRY_DEDUPE_WINDOW_MS = ORPHANED_AFTER_DEQUEUE_THRESHOLD_MS;
const ORPHANED_AFTER_DEQUEUE_THRESHOLD_MINUTES = Math.ceil(
  ORPHANED_AFTER_DEQUEUE_THRESHOLD_MS / MINUTE,
);

const orphanMap = new Map<number, number>();

const getOrphanedBeforeDequeueJobs = () =>
  db.query.taskRuns.findMany({
    where: and(
      eq(taskRuns.status, CloudTaskStatus.Pending),
      lt(
        taskRuns.createdAt,
        new Date(Date.now() - ORPHANED_PENDING_THRESHOLD_MS),
      ),
      gt(taskRuns.createdAt, new Date(Date.now() - 24 * HOUR)),
    ),
    orderBy: [asc(taskRuns.createdAt)],
  });

const getOrphanedAfterDequeueJobs = () =>
  db.query.taskRuns.findMany({
    where: and(
      eq(taskRuns.status, CloudTaskStatus.Dequeued),
      lt(
        taskRuns.dequeuedAt,
        new Date(Date.now() - ORPHANED_AFTER_DEQUEUE_THRESHOLD_MS),
      ),
    ),
    orderBy: [asc(taskRuns.createdAt)],
  });

export const getOrphanedJob = async () => {
  const orphanedJobs = (
    await Promise.all([
      getOrphanedBeforeDequeueJobs(),
      getOrphanedAfterDequeueJobs(),
    ])
  ).flat();

  for (let i = 0; i < orphanedJobs.length; i++) {
    const job = orphanedJobs[i];

    if (!job) {
      continue;
    }

    const ageMinutes = job.dequeuedAt
      ? ((Date.now() - job.dequeuedAt.getTime()) / 60_000).toFixed(0)
      : ((Date.now() - job.createdAt.getTime()) / 60_000).toFixed(0);

    const ageLabel = job.dequeuedAt ? 'dequeuedAt' : 'createdAt';

    console.log(
      `[getOrphanedJob] id=${job.id}, payloadKind=${job.payloadKind}, repo=${job.payload.repo}, ${ageLabel}=${ageMinutes}m ago`,
    );
  }

  const now = Date.now();

  for (const [jobId, timestamp] of orphanMap.entries()) {
    if (now - timestamp > ORPHAN_RETRY_DEDUPE_WINDOW_MS) {
      orphanMap.delete(jobId);
    }
  }

  const cloudJob = orphanedJobs.find((job) => !orphanMap.has(job.id));

  if (cloudJob) {
    orphanMap.set(cloudJob.id, now);

    console.warn(`[getOrphanedJob] Recovering orphaned job #${cloudJob.id}`, {
      payloadKind: cloudJob.payloadKind,
      repo: cloudJob.payload.repo,
      status: cloudJob.status,
      reason: cloudJob.dequeuedAt
        ? `dequeued for more than ${ORPHANED_AFTER_DEQUEUE_THRESHOLD_MINUTES} minutes without starting`
        : `pending for more than ${ORPHANED_PENDING_THRESHOLD_MS / MINUTE} minutes`,
    });

    // Release the lock and clear dequeuedAt before returning.
    await releaseCloudTask(cloudJob);

    await db
      .update(taskRuns)
      .set({ dequeuedAt: null })
      .where(eq(taskRuns.id, cloudJob.id));
  }

  return cloudJob;
};
