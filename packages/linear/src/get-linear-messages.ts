import { getRedis } from '@roomote/redis';

import type { LinearSessionMessage } from './types';

/**
 * Retrieve all queued Linear messages for a cloud job.
 * Messages are cleared after retrieval using an atomic transaction.
 */
export async function getLinearMessages(
  cloudJobId: number,
): Promise<LinearSessionMessage[]> {
  const redis = getRedis();
  const key = `linear:messages:${cloudJobId}`;

  // Use a transaction to atomically get and delete messages.
  // This prevents race conditions where messages added between lrange and del would be lost.
  const results = await redis.multi().lrange(key, 0, -1).del(key).exec();

  if (!results || results.length === 0) {
    return [];
  }

  // Check for errors in the lrange command (first command in transaction).
  const lrangeError = results[0]?.[0];

  if (lrangeError) {
    console.error(
      `[getLinearMessages] Redis lrange failed for cloud job ${cloudJobId}: ${lrangeError instanceof Error ? lrangeError.message : String(lrangeError)}`,
    );

    return [];
  }

  // Check for errors in the del command (second command in transaction).
  const delError = results[1]?.[0];

  if (delError) {
    console.error(
      `[getLinearMessages] Redis del failed for cloud job ${cloudJobId}: ${delError instanceof Error ? delError.message : String(delError)}`,
    );

    // Continue processing even if del fails - we still have the messages.
  }

  const rawMessages = results[0]?.[1] as string[];

  if (!rawMessages || rawMessages.length === 0) {
    return [];
  }

  console.log(
    `[getLinearMessages] Retrieved ${rawMessages.length} message(s) for cloud job ${cloudJobId}`,
  );

  // Parse messages with error handling to prevent crashes from corrupted data.
  const messages: LinearSessionMessage[] = [];

  for (const msg of rawMessages) {
    try {
      messages.push(JSON.parse(msg) as LinearSessionMessage);
    } catch (error) {
      console.error(
        `[getLinearMessages] Failed to parse message for cloud job ${cloudJobId}: ${error instanceof Error ? error.message : String(error)}`,
      );

      // Skip corrupted messages and continue processing.
    }
  }

  return messages;
}
