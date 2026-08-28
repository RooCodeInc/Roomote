import { Queue, QueueEvents, Worker } from 'bullmq';

import {
  PULL_REQUEST_MERGEABILITY_CHECK_QUEUE_NAME,
  type PullRequestMergeabilityCheckRequest,
} from '@roomote/sdk/server';

import { pullRequestMergeabilityCheckJob } from './jobs/pull-request-mergeability-check';
import { getRedis } from './redis';

export function startPullRequestMergeabilityCheckQueue() {
  const connection = getRedis();
  const queue = new Queue<PullRequestMergeabilityCheckRequest, void, string>(
    PULL_REQUEST_MERGEABILITY_CHECK_QUEUE_NAME,
    {
      connection,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 3_600, count: 100 },
        removeOnFail: { age: 24 * 3_600 },
      },
    },
  );
  const worker = new Worker<PullRequestMergeabilityCheckRequest, void, string>(
    PULL_REQUEST_MERGEABILITY_CHECK_QUEUE_NAME,
    pullRequestMergeabilityCheckJob,
    { connection, concurrency: 3, autorun: true },
  );
  const queueEvents = new QueueEvents(
    PULL_REQUEST_MERGEABILITY_CHECK_QUEUE_NAME,
    { connection },
  );

  worker.on('failed', (job, error) =>
    console.error(
      `[PullRequestMergeabilityCheckQueue] job ${job?.id} failed:`,
      error.message,
    ),
  );
  worker.on('error', (error) =>
    console.error('[PullRequestMergeabilityCheckQueue] worker error:', error),
  );

  return { queue, worker, queueEvents };
}
