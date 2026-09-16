import type { IosPushKind } from '@roomote/types';

import { enqueueScheduledNotification } from '../enqueue-scheduled-notification';

export const IOS_PUSH_NOTIFICATION_JOB = 'IosPushNotification';

export type IosPushNotificationJob = {
  userId: string;
  kind: IosPushKind;
  title: string;
  body: string;
  sessionId?: string;
  fastConversationId?: string;
  taskId?: string;
  requestId?: string;
  offerId?: string;
  capability?: string;
  collapseId?: string;
  /**
   * Distinguishes repeated pushes of the same kind for the same subject (a
   * Session gets many replies). Defaults to the most specific id present.
   */
  eventKey?: string;
};

const MAX_BODY_LENGTH = 200;
const MAX_TITLE_LENGTH = 100;

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

export function buildIosPushJobId(job: IosPushNotificationJob): string {
  const subject =
    job.eventKey ??
    job.requestId ??
    job.offerId ??
    job.taskId ??
    job.sessionId ??
    job.fastConversationId ??
    'none';
  // bullmq job ids cannot contain ':' safely in every tool, but the other
  // scheduled notifications already use them; keep the convention.
  return `ios-push:${job.userId}:${job.kind}:${subject}`;
}

/**
 * Queue an iOS push. Never throws: a queue outage must not fail whatever
 * user-facing flow noticed the event.
 */
export async function enqueueIosPush(
  input: IosPushNotificationJob,
): Promise<boolean> {
  const job: IosPushNotificationJob = {
    ...input,
    title: truncate(input.title, MAX_TITLE_LENGTH),
    body: truncate(input.body, MAX_BODY_LENGTH),
  };
  return enqueueScheduledNotification({
    name: IOS_PUSH_NOTIFICATION_JOB,
    data: job,
    jobId: buildIosPushJobId(job),
    logContext: `enqueueIosPush ${job.kind} for user ${job.userId}`,
  });
}
