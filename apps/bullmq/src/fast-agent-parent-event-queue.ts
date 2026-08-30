import { DelayedError, Queue, QueueEvents, Worker, type Job } from 'bullmq';

import {
  drainFastAgentParentEvents,
  FastAgentParentBusyError,
  FAST_AGENT_PARENT_EVENT_QUEUE_NAME,
  recoverPendingFastAgentParentEvents,
  type FastAgentParentEventQueueRequest,
} from '@roomote/sdk/server';

import { getRedis } from './redis';

const RECOVERY_JOB_NAME = 'recover-pending';
const RECOVERY_SCHEDULER_ID = 'fast-agent-parent-event-recovery';
const RECOVERY_INTERVAL_MS = 60_000;
const BUSY_PARENT_RETRY_DELAY_MS = 1_000;

type FastAgentParentEventJob =
  | FastAgentParentEventQueueRequest
  | { recovery: true };

async function processJob(job: Job<FastAgentParentEventJob>) {
  if (job.name === RECOVERY_JOB_NAME) {
    await recoverPendingFastAgentParentEvents();
    return;
  }
  if ('recovery' in job.data) return;
  try {
    await drainFastAgentParentEvents(job.data);
  } catch (error) {
    if (!(error instanceof FastAgentParentBusyError) || !job.token) {
      throw error;
    }
    await job.moveToDelayed(Date.now() + BUSY_PARENT_RETRY_DELAY_MS, job.token);
    throw new DelayedError();
  }
}

export async function startFastAgentParentEventQueue() {
  const connection = getRedis();
  const queue = new Queue<FastAgentParentEventJob>(
    FAST_AGENT_PARENT_EVENT_QUEUE_NAME,
    {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    },
  );

  await queue.upsertJobScheduler(
    RECOVERY_SCHEDULER_ID,
    { every: RECOVERY_INTERVAL_MS },
    { name: RECOVERY_JOB_NAME, data: { recovery: true } },
  );
  await recoverPendingFastAgentParentEvents();

  const worker = new Worker<FastAgentParentEventJob>(
    FAST_AGENT_PARENT_EVENT_QUEUE_NAME,
    processJob,
    // Busy parents immediately move back to delayed; no conversation can park
    // the worker pool while it owns an active Fast turn.
    { connection, concurrency: 20, autorun: true },
  );

  worker.on('failed', (job, error) =>
    console.error(
      `[FastAgentParentEventQueue] job ${job?.id} failed: ${error.message}`,
    ),
  );
  worker.on('error', (error) =>
    console.error('[FastAgentParentEventQueue] worker error:', error),
  );

  const queueEvents = new QueueEvents(FAST_AGENT_PARENT_EVENT_QUEUE_NAME, {
    connection,
  });
  queueEvents.on('failed', ({ jobId, failedReason }) =>
    console.error(
      `[FastAgentParentEventQueue] job ${jobId} failed: ${failedReason}`,
    ),
  );

  return { queue, worker, queueEvents };
}
