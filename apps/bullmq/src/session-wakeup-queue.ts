import { Queue, QueueEvents, Worker, type Job } from 'bullmq';

import {
  SESSION_WAKEUP_FIRE_JOB_NAME,
  SESSION_WAKEUP_QUEUE_NAME,
  fireSessionWakeup,
  recoverPendingSessionWakeups,
  type SessionWakeupFireJob,
} from '@roomote/sdk/server';

import { getRedis } from './redis';

const RECOVERY_JOB_NAME = 'recover-due';
const RECOVERY_SCHEDULER_ID = 'session-wakeup-recovery';
const RECOVERY_INTERVAL_MS = 60_000;

type SessionWakeupQueueJob = SessionWakeupFireJob | { recovery: true };

async function processJob(job: Job<SessionWakeupQueueJob>) {
  if (job.name === RECOVERY_JOB_NAME || 'recovery' in job.data) {
    const recovered = await recoverPendingSessionWakeups();
    if (recovered > 0) {
      console.log(
        `[SessionWakeupQueue] Re-added ${recovered} due wakeup hint(s).`,
      );
    }
    return;
  }
  if (job.name !== SESSION_WAKEUP_FIRE_JOB_NAME) return;
  const result = await fireSessionWakeup(job.data);
  if (result.outcome === 'skipped') {
    console.log(
      `[SessionWakeupQueue] Skipped wakeup ${job.data.wakeupId}: ${result.reason}`,
    );
  }
}

/**
 * Fires session wakeups. Every job is a hint for a `session_wakeups` row:
 * the row's `next_run_at` decides whether anything happens, and a recovery
 * sweep re-adds hints for due rows so lost jobs cannot strand a wakeup.
 */
export async function startSessionWakeupQueue() {
  const connection = getRedis();
  const queue = new Queue<SessionWakeupQueueJob>(SESSION_WAKEUP_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  });

  await queue.upsertJobScheduler(
    RECOVERY_SCHEDULER_ID,
    { every: RECOVERY_INTERVAL_MS },
    { name: RECOVERY_JOB_NAME, data: { recovery: true } },
  );
  await recoverPendingSessionWakeups();

  const worker = new Worker<SessionWakeupQueueJob>(
    SESSION_WAKEUP_QUEUE_NAME,
    processJob,
    // Firing only admits an event into the conversation's durable inbox; the
    // turn itself runs on the Fast parent event worker.
    { connection, concurrency: 10, autorun: true },
  );

  worker.on('failed', (job, error) =>
    console.error(
      `[SessionWakeupQueue] job ${job?.id} failed: ${error.message}`,
    ),
  );
  worker.on('error', (error) =>
    console.error('[SessionWakeupQueue] worker error:', error),
  );

  const queueEvents = new QueueEvents(SESSION_WAKEUP_QUEUE_NAME, {
    connection,
  });
  queueEvents.on('failed', ({ jobId, failedReason }) =>
    console.error(`[SessionWakeupQueue] job ${jobId} failed: ${failedReason}`),
  );

  return { queue, worker, queueEvents };
}
