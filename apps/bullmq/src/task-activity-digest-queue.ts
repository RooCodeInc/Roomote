import { Queue, Worker } from 'bullmq';

import {
  flushTaskActivityDigest,
  TASK_ACTIVITY_DIGEST_QUEUE_NAME,
  type TaskActivityDigestJob,
} from '@roomote/sdk/server';

import { getRedis } from './redis';

export function startTaskActivityDigestQueue() {
  const connection = getRedis();
  const queue = new Queue<TaskActivityDigestJob>(
    TASK_ACTIVITY_DIGEST_QUEUE_NAME,
    { connection },
  );
  const worker = new Worker<TaskActivityDigestJob>(
    TASK_ACTIVITY_DIGEST_QUEUE_NAME,
    (job) => flushTaskActivityDigest(job.data),
    { connection, concurrency: 10, autorun: true },
  );

  worker.on('failed', (job, error) =>
    console.error(
      `[TaskActivityDigestQueue] job ${job?.id} failed: ${error.message}`,
    ),
  );
  worker.on('error', (error) =>
    console.error('[TaskActivityDigestQueue] worker error:', error),
  );

  return { queue, worker };
}
