import { Queue, QueueEvents, Worker } from 'bullmq';

import { SNAPSHOT_JOB_RETRY_OPTIONS } from '@roomote/types';

import { getRedis } from './redis';
import { type SnapshotJobData, snapshotJob } from './jobs/snapshot';

const QUEUE_NAME = 'snapshot-jobs';

export function startSnapshotQueue() {
  const connection = getRedis();

  const queue = new Queue<SnapshotJobData, void, string>(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      ...SNAPSHOT_JOB_RETRY_OPTIONS,
      removeOnComplete: { age: 3600, count: 100 },
      removeOnFail: { age: 24 * 3600 },
    },
  });

  const worker = new Worker<SnapshotJobData, void, string>(
    QUEUE_NAME,
    snapshotJob,
    { connection, concurrency: 5, autorun: true, lockDuration: 180_000 },
  );

  worker.on('completed', (job) =>
    console.log(
      `[SnapshotQueue] job ${job.id} completed for cloudJob #${job.data.cloudJobId}`,
    ),
  );

  worker.on('failed', (job, err) =>
    console.error(
      `[SnapshotQueue] job ${job?.id} failed for cloudJob #${job?.data.cloudJobId}:`,
      err.message,
    ),
  );

  worker.on('error', (err) =>
    console.error('[SnapshotQueue] worker error:', err),
  );

  const queueEvents = new QueueEvents(QUEUE_NAME, { connection });

  queueEvents.on('completed', ({ jobId }) =>
    console.log(`[SnapshotQueue] job ${jobId} completed`),
  );

  queueEvents.on('failed', ({ jobId, failedReason }) =>
    console.error(`[SnapshotQueue] job ${jobId} failed: ${failedReason}`),
  );

  console.log('[SnapshotQueue] Started snapshot job worker');

  return {
    snapshotQueue: queue,
    snapshotWorker: worker,
    snapshotQueueEvents: queueEvents,
  };
}
