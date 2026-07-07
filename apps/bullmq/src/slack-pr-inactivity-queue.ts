import { Queue, QueueEvents, Worker } from 'bullmq';

import {
  SLACK_PR_INACTIVITY_QUEUE_NAME,
  type SlackPrInactivityCheckRequest,
} from '@roomote/sdk/server';

import { slackPrInactivityCheckJob } from './jobs/slack-pr-inactivity-check';
import { getRedis } from './redis';

export function startSlackPrInactivityQueue() {
  const connection = getRedis();

  const queue = new Queue<SlackPrInactivityCheckRequest, void, string>(
    SLACK_PR_INACTIVITY_QUEUE_NAME,
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

  const worker = new Worker<SlackPrInactivityCheckRequest, void, string>(
    SLACK_PR_INACTIVITY_QUEUE_NAME,
    slackPrInactivityCheckJob,
    { connection, concurrency: 5, autorun: true },
  );

  worker.on('completed', (job) =>
    console.log(
      `[SlackPrInactivityQueue] job ${job.id} completed for ${job.data.repository}#${job.data.prNumber}`,
    ),
  );

  worker.on('failed', (job, err) =>
    console.error(
      `[SlackPrInactivityQueue] job ${job?.id} failed for ${job?.data.repository}#${job?.data.prNumber}:`,
      err.message,
    ),
  );

  worker.on('error', (err) =>
    console.error('[SlackPrInactivityQueue] worker error:', err),
  );

  const queueEvents = new QueueEvents(SLACK_PR_INACTIVITY_QUEUE_NAME, {
    connection,
  });

  queueEvents.on('completed', ({ jobId }) =>
    console.log(`[SlackPrInactivityQueue] job ${jobId} completed`),
  );

  queueEvents.on('failed', ({ jobId, failedReason }) =>
    console.error(
      `[SlackPrInactivityQueue] job ${jobId} failed: ${failedReason}`,
    ),
  );

  console.log('[SlackPrInactivityQueue] Started PR inactivity check worker');

  return {
    slackPrInactivityQueue: queue,
    slackPrInactivityWorker: worker,
    slackPrInactivityQueueEvents: queueEvents,
  };
}
