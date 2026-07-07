import { Queue, QueueEvents, Worker, type Processor } from 'bullmq';

import { getRedis } from './redis';

/**
 * Shared BullMQ wiring for the per-surface suggested-tasks onboarding
 * follow-up queues. The queue names stay per surface (they are part of the
 * deployed contract for already-scheduled delayed jobs); only the setup
 * boilerplate is unified here.
 */
export function startSuggestedTasksOnboardingFollowupQueue<
  Request extends { sourceTaskId: string },
>({
  queueName,
  label,
  jobHandler,
  withQueueEvents = false,
}: {
  queueName: string;
  label: string;
  jobHandler: Processor<Request, void, string>;
  withQueueEvents?: boolean;
}): {
  queue: Queue<Request, void, string>;
  worker: Worker<Request, void, string>;
  queueEvents: QueueEvents | null;
} {
  const connection = getRedis();

  const queue = new Queue<Request, void, string>(queueName, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 3600, count: 100 },
      removeOnFail: { age: 24 * 3600 },
    },
  });

  const worker = new Worker<Request, void, string>(queueName, jobHandler, {
    connection,
    concurrency: 5,
    autorun: true,
  });

  worker.on('completed', (job) =>
    console.log(
      `[${label}] job ${job.id} completed for ${job.data.sourceTaskId}`,
    ),
  );

  worker.on('failed', (job, err) =>
    console.error(
      `[${label}] job ${job?.id} failed for ${job?.data.sourceTaskId}:`,
      err.message,
    ),
  );

  worker.on('error', (err) => console.error(`[${label}] worker error:`, err));

  let queueEvents: QueueEvents | null = null;

  if (withQueueEvents) {
    queueEvents = new QueueEvents(queueName, { connection });

    queueEvents.on('completed', ({ jobId }) =>
      console.log(`[${label}] job ${jobId} completed`),
    );

    queueEvents.on('failed', ({ jobId, failedReason }) =>
      console.error(`[${label}] job ${jobId} failed: ${failedReason}`),
    );
  }

  console.log(`[${label}] Started suggested-tasks onboarding follow-up worker`);

  return { queue, worker, queueEvents };
}
