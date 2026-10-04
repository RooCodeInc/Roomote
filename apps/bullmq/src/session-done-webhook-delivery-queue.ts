import { Queue, QueueEvents, Worker } from 'bullmq';

import { drainSessionDoneWebhookDeliveries } from '@roomote/sdk/server';

import { getRedis } from './redis';

export const SESSION_DONE_WEBHOOK_DELIVERY_QUEUE_NAME =
  'session-done-webhook-delivery-jobs';
export const SESSION_DONE_WEBHOOK_DELIVERY_JOB_NAME =
  'SessionDoneWebhookDelivery';

export async function startSessionDoneWebhookDeliveryQueue() {
  const connection = getRedis();
  const queue = new Queue<undefined, void, string>(
    SESSION_DONE_WEBHOOK_DELIVERY_QUEUE_NAME,
    {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { age: 3_600, count: 100 },
        removeOnFail: { age: 24 * 3_600 },
      },
    },
  );

  try {
    await queue.upsertJobScheduler(SESSION_DONE_WEBHOOK_DELIVERY_JOB_NAME, {
      every: 60_000,
    });
  } catch (error) {
    await queue.close().catch(() => {});
    throw error;
  }

  const worker = new Worker<undefined, void, string>(
    SESSION_DONE_WEBHOOK_DELIVERY_QUEUE_NAME,
    async () => {
      await drainSessionDoneWebhookDeliveries();
    },
    { connection, concurrency: 1, autorun: true },
  );

  worker.on('failed', (job, error) =>
    console.error(
      `[SessionDoneWebhookDeliveryQueue] job ${job?.id} failed:`,
      error,
    ),
  );
  worker.on('error', (error) =>
    console.error('[SessionDoneWebhookDeliveryQueue] worker error:', error),
  );

  const queueEvents = new QueueEvents(
    SESSION_DONE_WEBHOOK_DELIVERY_QUEUE_NAME,
    {
      connection,
    },
  );
  queueEvents.on('failed', ({ jobId, failedReason }) =>
    console.error(
      `[SessionDoneWebhookDeliveryQueue] job ${jobId} failed: ${failedReason}`,
    ),
  );

  return { queue, worker, queueEvents };
}
