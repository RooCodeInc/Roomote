import { Queue, QueueEvents, Worker } from 'bullmq';

import {
  SLACK_ACCOUNT_LINK_EDUCATION_QUEUE_NAME,
  type SlackAccountLinkEducationRequest,
} from '@roomote/sdk/server';

import { slackAccountLinkEducationJob } from './jobs/slack-account-link-education';
import { getRedis } from './redis';

export function startSlackAccountLinkEducationQueue() {
  const connection = getRedis();

  const queue = new Queue<SlackAccountLinkEducationRequest, void, string>(
    SLACK_ACCOUNT_LINK_EDUCATION_QUEUE_NAME,
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

  const worker = new Worker<SlackAccountLinkEducationRequest, void, string>(
    SLACK_ACCOUNT_LINK_EDUCATION_QUEUE_NAME,
    slackAccountLinkEducationJob,
    { connection, concurrency: 5, autorun: true },
  );

  worker.on('completed', (job) =>
    console.log(
      `[SlackAccountLinkEducationQueue] job ${job.id} completed for ${job.data.slackUserId}`,
    ),
  );

  worker.on('failed', (job, err) =>
    console.error(
      `[SlackAccountLinkEducationQueue] job ${job?.id} failed for ${job?.data.slackUserId}:`,
      err.message,
    ),
  );

  worker.on('error', (err) =>
    console.error('[SlackAccountLinkEducationQueue] worker error:', err),
  );

  const queueEvents = new QueueEvents(SLACK_ACCOUNT_LINK_EDUCATION_QUEUE_NAME, {
    connection,
  });

  queueEvents.on('completed', ({ jobId }) =>
    console.log(`[SlackAccountLinkEducationQueue] job ${jobId} completed`),
  );

  queueEvents.on('failed', ({ jobId, failedReason }) =>
    console.error(
      `[SlackAccountLinkEducationQueue] job ${jobId} failed: ${failedReason}`,
    ),
  );

  console.log('[SlackAccountLinkEducationQueue] Started account-link worker');

  return {
    slackAccountLinkEducationQueue: queue,
    slackAccountLinkEducationWorker: worker,
    slackAccountLinkEducationQueueEvents: queueEvents,
  };
}
