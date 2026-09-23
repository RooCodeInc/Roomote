import { and, desc, eq } from 'drizzle-orm';

import {
  ACP_ENVELOPE_EVENT_TYPES,
  asRecord,
  extractAcpMessageText,
  toIntegrationToolUserRequest,
} from '@roomote/types';

import { db } from '../db';
import { taskMessages } from '../schema';

/**
 * What the user last asked this task for, as Auto mode is shown it next to
 * a tool call: the task's latest recorded prompt, the one its agent is
 * working on. Undefined when the task has none yet.
 */
export async function findLatestTaskUserRequest(
  taskId: string,
): Promise<string | undefined> {
  const [latest] = await db
    .select({
      contentBlocks: taskMessages.contentBlocks,
      payload: taskMessages.payload,
    })
    .from(taskMessages)
    .where(
      and(
        eq(taskMessages.taskId, taskId),
        eq(taskMessages.eventType, ACP_ENVELOPE_EVENT_TYPES.UserPrompt),
      ),
    )
    .orderBy(desc(taskMessages.ts), desc(taskMessages.createdAt))
    .limit(1);
  if (!latest) return undefined;
  return toIntegrationToolUserRequest(
    extractAcpMessageText(
      latest.contentBlocks,
      asRecord(latest.payload) ?? null,
    ),
  );
}
