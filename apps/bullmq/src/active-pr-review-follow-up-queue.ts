import { Queue, QueueEvents, Worker } from 'bullmq';

import {
  ACTIVE_PR_REVIEW_FOLLOW_UP_JOB_OPTIONS,
  ACTIVE_PR_REVIEW_FOLLOW_UP_QUEUE_NAME,
  type ActivePrReviewFollowUpRequest,
} from '@roomote/sdk/server';

import { activePrReviewFollowUpJob } from './jobs/active-pr-review-follow-up';
import { getRedis } from './redis';

export function startActivePrReviewFollowUpQueue() {
  const connection = getRedis();
  const queue = new Queue<ActivePrReviewFollowUpRequest, void, string>(
    ACTIVE_PR_REVIEW_FOLLOW_UP_QUEUE_NAME,
    {
      connection,
      defaultJobOptions: ACTIVE_PR_REVIEW_FOLLOW_UP_JOB_OPTIONS,
    },
  );
  const worker = new Worker<ActivePrReviewFollowUpRequest, void, string>(
    ACTIVE_PR_REVIEW_FOLLOW_UP_QUEUE_NAME,
    activePrReviewFollowUpJob,
    { connection, concurrency: 5, autorun: true },
  );
  const queueEvents = new QueueEvents(ACTIVE_PR_REVIEW_FOLLOW_UP_QUEUE_NAME, {
    connection,
  });

  worker.on('failed', (job, error) =>
    console.error(
      `[ActivePrReviewFollowUpQueue] job ${job?.id} failed:`,
      error.message,
    ),
  );
  worker.on('error', (error) =>
    console.error('[ActivePrReviewFollowUpQueue] worker error:', error),
  );

  console.log(
    '[ActivePrReviewFollowUpQueue] Started active PR review follow-up worker',
  );

  return { queue, worker, queueEvents };
}
