import {
  and,
  db,
  eq,
  isNull,
  userDevices,
  type UserDevice,
} from '@roomote/db/server';
import type { IosPushKind } from '@roomote/types';

import { sendApnsPush, type ApnsCredentials, type ApnsTransport } from './apns';
import { resolveApnsCredentials } from './connection';
import type { IosPushNotificationJob } from './enqueue';

export type IosPushNotificationResult =
  | 'sent'
  | 'not_configured'
  | 'no_devices'
  | 'failed';

/**
 * The APNs payload per `apps/ios/docs/api-v1.md` ("Push payloads"): the
 * `aps` alert plus a `data` object the app uses to deep-link and act.
 */
export function buildIosPushPayload(
  job: IosPushNotificationJob,
): Record<string, unknown> {
  const threadId = job.sessionId ?? job.taskId;
  const url = job.sessionId
    ? `roomote://sessions/${job.sessionId}`
    : job.taskId
      ? `roomote://tasks/${job.taskId}`
      : undefined;
  return {
    aps: {
      alert: { title: job.title, body: job.body },
      category: job.kind.toUpperCase(),
      ...(threadId ? { 'thread-id': threadId } : {}),
      'mutable-content': 1,
      sound: 'default',
    },
    data: {
      kind: job.kind,
      sessionId: job.sessionId ?? null,
      fastConversationId: job.fastConversationId ?? null,
      taskId: job.taskId ?? null,
      ...(job.requestId ? { requestId: job.requestId } : {}),
      ...(job.offerId ? { offerId: job.offerId } : {}),
      ...(job.capability ? { capability: job.capability } : {}),
      ...(url ? { url } : {}),
    },
  };
}

function deviceWantsKind(device: UserDevice, kind: IosPushKind): boolean {
  const categories = device.categories ?? {};
  return categories[kind] !== false;
}

async function disableDevice(deviceId: string, reason: string): Promise<void> {
  await db
    .update(userDevices)
    .set({ disabledAt: new Date(), updatedAt: new Date() })
    .where(eq(userDevices.id, deviceId));
  console.info(`[iosPush] Disabled device ${deviceId}: ${reason}`);
}

/**
 * Fan one queued push out to the user's enabled devices. Retryable APNs
 * failures propagate so bullmq backs off; a token Apple says is gone
 * disables the device row instead of failing the job.
 */
export async function processIosPushNotificationJob(
  job: IosPushNotificationJob,
  options: {
    transport?: ApnsTransport;
    credentials?: ApnsCredentials | null;
  } = {},
): Promise<IosPushNotificationResult> {
  const credentials =
    options.credentials !== undefined
      ? options.credentials
      : await resolveApnsCredentials();
  if (!credentials) return 'not_configured';

  const devices = await db.query.userDevices.findMany({
    where: and(
      eq(userDevices.userId, job.userId),
      eq(userDevices.platform, 'ios'),
      isNull(userDevices.disabledAt),
    ),
  });
  const targets = devices.filter((device) => deviceWantsKind(device, job.kind));
  if (targets.length === 0) return 'no_devices';

  const payload = buildIosPushPayload(job);
  let sent = 0;
  let retryable: unknown = null;
  for (const device of targets) {
    try {
      const result = await sendApnsPush(
        {
          credentials,
          deviceToken: device.token,
          environment: device.environment,
          payload,
          ...(job.collapseId ? { collapseId: job.collapseId } : {}),
        },
        options.transport,
      );
      if (result.outcome === 'sent') {
        sent += 1;
      } else if (result.outcome === 'unregistered') {
        await disableDevice(device.id, result.reason);
      } else {
        console.warn(
          `[iosPush] APNs rejected ${job.kind} for device ${device.id}: ${result.status} ${result.reason}`,
        );
      }
    } catch (error) {
      // Keep going so one bad device does not starve the others, then let
      // the queue retry the whole job. Devices that already got the push
      // may see it again on retry; a repeat is the lesser evil versus a
      // lost notification.
      retryable = error;
      console.warn(
        `[iosPush] APNs send failed for device ${device.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (retryable) throw retryable;
  return sent > 0 ? 'sent' : 'failed';
}
