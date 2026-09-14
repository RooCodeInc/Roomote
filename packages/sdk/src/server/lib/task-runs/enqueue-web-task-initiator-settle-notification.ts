import { RunStatus } from '@roomote/types';
import { enqueueScheduledNotification } from '../enqueue-scheduled-notification';

export const WEB_TASK_INITIATOR_SETTLE_NOTIFICATION_JOB =
  'WebTaskInitiatorSettleNotification';

export type WebTaskInitiatorSettleNotificationJob = {
  runId: number;
  taskId: string;
  status: RunStatus.Completed | RunStatus.Failed | RunStatus.Canceled;
};

/** Requests a durable retry without letting queue outages fail task finalization. */
export async function enqueueWebTaskInitiatorSettleNotification(
  job: WebTaskInitiatorSettleNotificationJob,
): Promise<boolean> {
  return enqueueScheduledNotification({
    name: WEB_TASK_INITIATOR_SETTLE_NOTIFICATION_JOB,
    data: job,
    jobId: `web-task-initiator-settle:${job.runId}:${job.status}`,
    logContext: `enqueueWebTaskInitiatorSettleNotification run ${job.runId}`,
  });
}
