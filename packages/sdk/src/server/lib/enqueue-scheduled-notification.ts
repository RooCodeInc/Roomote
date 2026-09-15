import { Queue } from 'bullmq';

import { getRedis } from '@roomote/redis';

const SCHEDULED_JOBS_QUEUE = 'scheduled-jobs';
let queue: Queue | null = null;

function getQueue(): Queue {
  queue ??= new Queue(SCHEDULED_JOBS_QUEUE, { connection: getRedis() });
  return queue;
}

export async function enqueueScheduledNotification(input: {
  name: string;
  data: unknown;
  jobId: string;
  logContext: string;
  delay?: number;
}): Promise<boolean> {
  try {
    await getQueue().add(input.name, input.data, {
      jobId: input.jobId,
      ...(input.delay ? { delay: input.delay } : {}),
      attempts: 3,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: { age: 3_600, count: 100 },
      removeOnFail: { age: 24 * 3_600 },
    });
    return true;
  } catch (error) {
    console.error(
      `[${input.logContext}] Failed to enqueue retry: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
