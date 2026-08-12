import { Queue, QueueEvents, Worker } from 'bullmq';

import {
  PR_REVIEW_NOTIFICATION_QUEUE_NAME,
  type PrReviewNotificationQueueRequest,
} from '@roomote/sdk/server';

import { prReviewNotificationJob } from './jobs/pr-review-notification';
import { getRedis } from './redis';

function formatJobTarget(data: PrReviewNotificationQueueRequest): string {
  const target = 'input' in data ? data.input : data;

  return `${target.repository}#${target.prNumber}`;
}

export function startPrReviewNotificationQueue() {
  const connection = getRedis();

  const queue = new Queue<PrReviewNotificationQueueRequest, void, string>(
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

  const worker = new Worker<PrReviewNotificationQueueRequest, void, string>(
    PR_REVIEW_NOTIFICATION_QUEUE_NAME,
    prReviewNotificationJob,
    { connection, concurrency: 5, autorun: true },
  );

  worker.on('failed', (job, err) =>
    console.error(
      `[PrReviewNotificationQueue] job ${job?.id} failed for ${
        job?.data ? formatJobTarget(job.data) : 'unknown pull request'
      }:`,
      err.message,
    ),
  );

  worker.on('error', (err) =>
    console.error('[PrReviewNotificationQueue] worker error:', err),
  );

  const queueEvents = new QueueEvents(PR_REVIEW_NOTIFICATION_QUEUE_NAME, {
    connection,
  });

  queueEvents.on('completed', ({ jobId }) =>
    console.log(`[PrReviewNotificationQueue] job ${jobId} completed`),
  );

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
