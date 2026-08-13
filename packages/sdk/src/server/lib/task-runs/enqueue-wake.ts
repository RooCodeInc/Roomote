import { Queue } from 'bullmq';
import { z } from 'zod';

import { getRedis } from '@roomote/redis';

export const TASK_WAKE_QUEUE_NAME = 'task-wake-jobs';

export const taskWakeRequestSchema = z.object({
  runId: z.number().int().positive(),
  waitUntil: z.string().datetime(),
});

export type TaskWakeRequest = z.infer<typeof taskWakeRequestSchema>;

let taskWakeQueue: Queue<TaskWakeRequest> | null = null;

function getTaskWakeQueue(): Queue<TaskWakeRequest> {
  taskWakeQueue ??= new Queue<TaskWakeRequest>(TASK_WAKE_QUEUE_NAME, {
    connection: getRedis(),
    defaultJobOptions: {
      // Sleeping includes turn settlement plus provider snapshot/standby work.
      // Retry long enough for that handoff without keeping compute awake.
      attempts: 30,
      backoff: { type: 'fixed', delay: 30_000 },
      removeOnComplete: { age: 24 * 3_600, count: 1_000 },
      removeOnFail: { age: 7 * 24 * 3_600 },
    },
  });
  return taskWakeQueue;
}

export async function enqueueTaskWake(request: TaskWakeRequest): Promise<void> {
  const waitUntilMs = new Date(request.waitUntil).getTime();
  const queue = getTaskWakeQueue();
  const jobId = `task-wake-${request.runId}`;
  const existingJob = await queue.getJob(jobId);
  if (existingJob) {
    const state = await existingJob.getState();
    if (
      state === 'active' ||
      state === 'delayed' ||
      state === 'waiting' ||
      state === 'prioritized' ||
      state === 'waiting-children'
    ) {
      return;
    }
    await existingJob.remove();
  }
  await queue.add('wake-task', request, {
    jobId,
    delay: Math.max(0, waitUntilMs - Date.now()),
  });
}

export async function removeTaskWake(runId: number): Promise<void> {
  const job = await getTaskWakeQueue().getJob(`task-wake-${runId}`);
  await job?.remove();
}
