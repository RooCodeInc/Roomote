import { Queue, QueueEvents, Worker, type Job } from 'bullmq';

import {
  drainFastAgentParentEvents,
  FAST_AGENT_PARENT_EVENT_QUEUE_NAME,
  recoverPendingFastAgentParentEvents,
  type FastAgentParentEventQueueRequest,
} from '@roomote/sdk/server';

import { getRedis } from './redis';

const RECOVERY_JOB_NAME = 'recover-pending';
const RECOVERY_SCHEDULER_ID = 'fast-agent-parent-event-recovery';
const RECOVERY_INTERVAL_MS = 60_000;

type FastAgentParentEventJob =
  | FastAgentParentEventQueueRequest
  | { recovery: true };

async function processJob(job: Job<FastAgentParentEventJob>) {
  if (job.name === RECOVERY_JOB_NAME) {
    await recoverPendingFastAgentParentEvents();
    return;
  }
  if ('recovery' in job.data) return;
  await drainFastAgentParentEvents(job.data);
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
    // A busy parent consumes only its own slot while other conversations keep
    // draining. Ordering within each parent comes from the durable DB inbox.
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
