import { dispatchDuePrReviewNotifications } from '@roomote/sdk/server';

export async function prReviewNotificationDispatchJob(): Promise<void> {
  await dispatchDuePrReviewNotifications();
}
