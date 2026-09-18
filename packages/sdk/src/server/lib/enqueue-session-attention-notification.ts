import { createHash } from 'node:crypto';

import type { SessionAttentionKind } from './session-attention-notification';
import { enqueueScheduledNotification } from './enqueue-scheduled-notification';

export const SESSION_ATTENTION_NOTIFICATION_JOB =
  'SessionAttentionNotification';

export type SessionAttentionNotificationJob =
  | {
      target: 'task';
      phase?: 'recovery' | 'browser_fallback';
      runId: number;
      eventId: string;
      kind: SessionAttentionKind;
      presentationKind?: import('./session-attention-notification').SessionAttentionPresentationKind;
      message?: string;
    }
  | {
      target: 'fast_session';
      phase?: 'recovery' | 'browser_fallback';
      fastConversationId: string;
      eventId: string;
      kind: SessionAttentionKind;
      presentationKind?: import('./session-attention-notification').SessionAttentionPresentationKind;
      message?: string;
      manual: boolean;
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
