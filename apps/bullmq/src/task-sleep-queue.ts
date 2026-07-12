import { Queue, QueueEvents, Worker } from 'bullmq';

import {
  TASK_SLEEP_QUEUE_NAME,
  type TaskSleepRequest,
} from '@roomote/sdk/server';

import { getRedis } from './redis';
import { sleepTaskRunNow } from './scheduled-jobs/sleep-check';

export function startTaskSleepQueue() {
  const connection = getRedis();
  const queue = new Queue<TaskSleepRequest, void, string>(
    TASK_SLEEP_QUEUE_NAME,
    { connection },
  );
  const worker = new Worker<TaskSleepRequest, void, string>(
    TASK_SLEEP_QUEUE_NAME,
    ({ data }) => sleepTaskRunNow(data.runId),
    { connection, concurrency: 5, autorun: true },
  );
  const queueEvents = new QueueEvents(TASK_SLEEP_QUEUE_NAME, { connection });

  worker.on('failed', (job, error) => {
    console.error(
      `[TaskSleepQueue] job ${job?.id} failed for task run #${job?.data.runId}:`,
      error.message,
    );
  });

  worker.on('error', (error) => {
    console.error('[TaskSleepQueue] worker error:', error);
  });

  console.log('[TaskSleepQueue] Started task sleep worker');

  return { queue, worker, queueEvents };
}
