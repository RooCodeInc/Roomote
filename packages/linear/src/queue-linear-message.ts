import { getRedis } from '@roomote/redis';

import type { AgentSessionEventPayload, LinearSessionMessage } from './types';

const LINEAR_MESSAGE_QUEUE_PREFIX = 'linear:messages:';
const LINEAR_MESSAGE_QUEUE_TTL = 60 * 60; // 1 hour TTL for queued messages

/**
 * Escape newline and carriage return characters to prevent log injection attacks.
 * This sanitizes untrusted input before including it in log messages.
 */
function escapeForLog(value: string): string {
  return value.replace(/[\r\n]/g, '\\n');
}

/**
 * Queue a Linear session message for processing by an active task run.
 *
 * This is used when a follow-up message arrives for a session that
 * already has an active task run running. The run will poll for new messages.
 *
 * Note: Uses runId as the key (matching getLinearMessages) to ensure
 * the worker can retrieve messages by run ID.
 */
export async function queueLinearMessage(
  runId: number,
  sessionId: string,
  payload: AgentSessionEventPayload,
  userId?: string,
): Promise<boolean> {
  const message: LinearSessionMessage = {
    sessionId,
    organizationId: payload.organizationId,
    action: payload.action,
    payload,
    userId,
    timestamp: Date.now(),
  };

  const redis = getRedis();
  const key = `${LINEAR_MESSAGE_QUEUE_PREFIX}${runId}`;

  // Push the message to the list
  await redis.rpush(key, JSON.stringify(message));

  // Set TTL to prevent orphaned messages
  await redis.expire(key, LINEAR_MESSAGE_QUEUE_TTL);

  console.log(
    `[queueLinearMessage] Queued message for task run ${runId} (session ${escapeForLog(sessionId)})`,
  );

  return true;
}

export async function prependLinearMessages(
  runId: number,
  messages: LinearSessionMessage[],
): Promise<void> {
  if (messages.length === 0) {
    return;
  }

  const redis = getRedis();
  const key = `${LINEAR_MESSAGE_QUEUE_PREFIX}${runId}`;
  const multi = redis.multi();

  for (const message of [...messages].reverse()) {
    multi.lpush(key, JSON.stringify(message));
  }

  multi.expire(key, LINEAR_MESSAGE_QUEUE_TTL);
  await multi.exec();

  console.log(
    `[prependLinearMessages] Requeued ${messages.length} message(s) for task run ${runId}`,
  );
}

/**
 * Clear all queued messages for a Linear task run.
 * Used when a run is completed or cancelled.
 */
export async function clearLinearMessageQueue(runId: number): Promise<void> {
  const redis = getRedis();
  const key = `${LINEAR_MESSAGE_QUEUE_PREFIX}${runId}`;
  await redis.del(key);
  console.log(`[clearLinearMessageQueue] Cleared queue for task run ${runId}`);
}
