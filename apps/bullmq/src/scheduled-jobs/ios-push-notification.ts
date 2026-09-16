import {
  processIosPushNotificationJob,
  type IosPushNotificationJob,
} from '@roomote/sdk/server';

/**
 * Deliver one queued iOS push. Retryable APNs failures throw so bullmq
 * backs off; an unconfigured deployment or a user with no devices is a
 * quiet no-op.
 */
export async function iosPushNotificationJob(
  data: IosPushNotificationJob,
): Promise<void> {
  const result = await processIosPushNotificationJob(data);
  if (result === 'failed') {
    throw new Error(
      `iOS push ${data.kind} for user ${data.userId} reached no device`,
    );
  }
}
