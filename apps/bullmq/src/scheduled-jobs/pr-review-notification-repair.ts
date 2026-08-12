import { repairPendingPrReviewNotificationJobs } from '@roomote/sdk/server';

export async function prReviewNotificationRepairJob(): Promise<void> {
  await repairPendingPrReviewNotificationJobs();
}
