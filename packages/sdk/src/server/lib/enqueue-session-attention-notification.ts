import { createHash } from 'node:crypto';

import { Queue } from 'bullmq';
import { getRedis } from '@roomote/redis';

import type { SessionAttentionKind } from './session-attention-notification';

export const SESSION_ATTENTION_NOTIFICATION_JOB =
  'SessionAttentionNotification';
const SCHEDULED_JOBS_QUEUE = 'scheduled-jobs';

export type SessionAttentionNotificationJob =
  | {
      target: 'task';
      runId: number;
      eventId: string;
      kind: SessionAttentionKind;
    }
  | {
      target: 'fast_session';
      fastConversationId: string;
      eventId: string;
      kind: SessionAttentionKind;
    };

let queue: Queue<SessionAttentionNotificationJob> | null = null;

function getQueue(): Queue<SessionAttentionNotificationJob> {
  queue ??= new Queue(SCHEDULED_JOBS_QUEUE, { connection: getRedis() });
  return queue;
}

export async function enqueueSessionAttentionNotification(
  job: SessionAttentionNotificationJob,
): Promise<boolean> {
  try {
    const digest = createHash('sha256')
      .update(JSON.stringify(job))
      .digest('hex')
      .slice(0, 24);
    await getQueue().add(SESSION_ATTENTION_NOTIFICATION_JOB, job, {
      jobId: `session-attention-${digest}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: { age: 3_600, count: 100 },
      removeOnFail: { age: 24 * 3_600 },
    });
    return true;
  } catch (error) {
    console.error(
      `[enqueueSessionAttentionNotification] Failed to enqueue retry: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
