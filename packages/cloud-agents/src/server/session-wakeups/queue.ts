import { Queue } from 'bullmq';

import { getRedis } from '@roomote/redis';

/**
 * Delayed BullMQ jobs are only wakeup hints for `session_wakeups` rows; the
 * row's `next_run_at` is the source of truth and the firing path claims it
 * with a compare-and-set. The job id carries the occurrence time so the
 * creator's hint and every recovery sweep collapse into one job, while a
 * later occurrence of the same wakeup gets its own.
 */
export const SESSION_WAKEUP_QUEUE_NAME = 'session-wakeups';
export const SESSION_WAKEUP_FIRE_JOB_NAME = 'fire';

export type SessionWakeupFireJob = {
  wakeupId: string;
  /** Unix milliseconds of the occurrence this job fires. */
  runAt: number;
};

let sessionWakeupQueue: Queue<SessionWakeupFireJob> | null = null;

function getSessionWakeupQueue(): Queue<SessionWakeupFireJob> {
  sessionWakeupQueue ??= new Queue<SessionWakeupFireJob>(
    SESSION_WAKEUP_QUEUE_NAME,
    {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: true,
        // PostgreSQL remains the source of truth; the recovery sweep re-adds
        // a hint for any due row whose job was lost.
        removeOnFail: true,
      },
    },
  );
  return sessionWakeupQueue;
}

export function buildSessionWakeupFireJobId(job: SessionWakeupFireJob): string {
  return `${job.wakeupId}:${job.runAt}`;
}

/**
 * Add the delayed hint for one occurrence. Failure is not fatal for callers
 * that already persisted the row: the recovery sweep re-adds it.
 */
export async function enqueueSessionWakeupFire(
  job: SessionWakeupFireJob,
): Promise<void> {
  await getSessionWakeupQueue().add(SESSION_WAKEUP_FIRE_JOB_NAME, job, {
    jobId: buildSessionWakeupFireJobId(job),
    delay: Math.max(0, job.runAt - Date.now()),
  });
}

export function enqueueSessionWakeupFireBestEffort(
  job: SessionWakeupFireJob,
): void {
  void enqueueSessionWakeupFire(job).catch((error) => {
    console.error(
      `[SessionWakeups] Persisted wakeup ${job.wakeupId}, but its delayed job failed to enqueue: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}
