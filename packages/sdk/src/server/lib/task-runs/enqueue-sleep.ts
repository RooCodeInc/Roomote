import { Queue, QueueEvents } from 'bullmq';
import { z } from 'zod';

import { getRedis } from '@roomote/redis';

export const TASK_SLEEP_QUEUE_NAME = 'task-sleep-jobs';
const TASK_SLEEP_RESULT_TIMEOUT_MS = 60_000;

const BLOCKING_JOB_STATES = new Set([
  'active',
  'delayed',
  'prioritized',
  'waiting',
  'waiting-children',
]);

export const taskSleepRequestSchema = z.object({
  runId: z.number(),
});

export type TaskSleepRequest = z.infer<typeof taskSleepRequestSchema>;

let taskSleepQueue: Queue<TaskSleepRequest> | null = null;
let taskSleepQueueEvents: QueueEvents | null = null;

function getTaskSleepQueue(): Queue<TaskSleepRequest> {
  if (!taskSleepQueue) {
    taskSleepQueue = new Queue<TaskSleepRequest>(TASK_SLEEP_QUEUE_NAME, {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { age: 3_600, count: 100 },
        removeOnFail: { age: 24 * 3_600 },
      },
    });
  }

  return taskSleepQueue;
}

function getTaskSleepQueueEvents(): QueueEvents {
  if (!taskSleepQueueEvents) {
    taskSleepQueueEvents = new QueueEvents(TASK_SLEEP_QUEUE_NAME, {
      connection: getRedis(),
    });
  }

  return taskSleepQueueEvents;
}

/** Enqueue an immediate provider-neutral sleep request for a task run. */
export async function enqueueTaskSleep(
  request: TaskSleepRequest,
): Promise<boolean> {
  const queue = getTaskSleepQueue();
  const jobId = `task-sleep-${request.runId}`;
  const existingJob = await queue.getJob(jobId);

  if (existingJob) {
    const state = await existingJob.getState();

    if (BLOCKING_JOB_STATES.has(state)) {
      await existingJob.waitUntilFinished(
        getTaskSleepQueueEvents(),
        TASK_SLEEP_RESULT_TIMEOUT_MS,
      );
      return false;
    }

    await existingJob.remove();
  }

  const job = await queue.add('sleep-task', request, { jobId });
  await job.waitUntilFinished(
    getTaskSleepQueueEvents(),
    TASK_SLEEP_RESULT_TIMEOUT_MS,
  );
  return true;
}
