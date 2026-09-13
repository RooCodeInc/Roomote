import { createHash } from 'node:crypto';

import type { SessionAttentionKind } from './session-attention-notification';
import { enqueueScheduledNotification } from './enqueue-scheduled-notification';

export const SESSION_ATTENTION_NOTIFICATION_JOB =
  'SessionAttentionNotification';

export type SessionAttentionNotificationJob =
  | {
      target: 'task';
      runId: number;
      eventId: string;
      kind: SessionAttentionKind;
      message?: string;
    }
  | {
      target: 'fast_session';
      fastConversationId: string;
      eventId: string;
      kind: SessionAttentionKind;
      message?: string;
    };

export async function enqueueSessionAttentionNotification(
  job: SessionAttentionNotificationJob,
  options: { delay?: number } = {},
): Promise<boolean> {
  const digest = createHash('sha256')
    .update(JSON.stringify(job))
    .digest('hex')
    .slice(0, 24);
  return enqueueScheduledNotification({
    name: SESSION_ATTENTION_NOTIFICATION_JOB,
    data: job,
    jobId: `session-attention-${digest}`,
    logContext: 'enqueueSessionAttentionNotification',
    delay: options.delay,
  });
}
