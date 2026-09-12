import { Queue } from 'bullmq';

import { getRedis } from '@roomote/redis';
import { RunStatus } from '@roomote/types';

export const WEB_TASK_INITIATOR_SETTLE_NOTIFICATION_JOB =
  'WebTaskInitiatorSettleNotification';
const SCHEDULED_JOBS_QUEUE = 'scheduled-jobs';

export type WebTaskInitiatorSettleNotificationJob = {
  runId: number;
  taskId: string;
  status: RunStatus.Completed | RunStatus.Failed | RunStatus.Canceled;
};

let queue: Queue<WebTaskInitiatorSettleNotificationJob> | null = null;

function getQueue(): Queue<WebTaskInitiatorSettleNotificationJob> {
  queue ??= new Queue(SCHEDULED_JOBS_QUEUE, { connection: getRedis() });
  return queue;
}

/** Requests a durable retry without letting queue outages fail task finalization. */
export async function enqueueWebTaskInitiatorSettleNotification(
  job: WebTaskInitiatorSettleNotificationJob,
): Promise<boolean> {
  try {
    await getQueue().add(WEB_TASK_INITIATOR_SETTLE_NOTIFICATION_JOB, job, {
      jobId: `web-task-initiator-settle:${job.runId}:${job.status}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: { age: 3_600, count: 100 },
      removeOnFail: { age: 24 * 3_600 },
    });
    return true;
  } catch (error) {
    console.error(
      `[enqueueWebTaskInitiatorSettleNotification] Failed to enqueue retry for run ${job.runId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
