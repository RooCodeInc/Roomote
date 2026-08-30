import { Queue, QueueEvents, Worker } from 'bullmq';

import {
  PR_REVIEW_NOTIFICATION_QUEUE_NAME,
  type PrReviewNotificationRequest,
} from '@roomote/sdk/server';

import { prReviewNotificationJob } from './jobs/pr-review-notification';
import { getRedis } from './redis';

export function startPrReviewNotificationQueue() {
  const connection = getRedis();

  const queue = new Queue<PrReviewNotificationRequest, void, string>(
    PR_REVIEW_NOTIFICATION_QUEUE_NAME,
    {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: { age: 24 * 3600 },
      },
    },
  );

  const worker = new Worker<PrReviewNotificationRequest, void, string>(
    PR_REVIEW_NOTIFICATION_QUEUE_NAME,
    prReviewNotificationJob,
    { connection, concurrency: 5, autorun: true },
  );

  worker.on('failed', (job, err) =>
    console.error(
      `[PrReviewNotificationQueue] job ${job?.id} failed for ${job?.data.repository}#${job?.data.prNumber}:`,
      err.message,
    ),
  );

  worker.on('error', (err) =>
    console.error('[PrReviewNotificationQueue] worker error:', err),
  );

  const queueEvents = new QueueEvents(PR_REVIEW_NOTIFICATION_QUEUE_NAME, {
    connection,
  });

  queueEvents.on('failed', ({ jobId, failedReason }) =>
    console.error(
      `[PrReviewNotificationQueue] job ${jobId} failed: ${failedReason}`,
    ),
  );

  console.log(
    '[PrReviewNotificationQueue] Started PR review notification worker',
  );

  return {
    prReviewNotificationQueue: queue,
    prReviewNotificationWorker: worker,
    prReviewNotificationQueueEvents: queueEvents,
  };
}
