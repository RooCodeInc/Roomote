import { and, desc, eq, sql } from 'drizzle-orm';

import {
  ACP_ENVELOPE_EVENT_TYPES,
  asRecord,
  extractAcpMessageText,
  toIntegrationToolUserRequest,
} from '@roomote/types';

import { db } from '../db';
import { fastAgentMessages, taskMessages } from '../schema';

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

/**
 * What this user last asked a Fast conversation for, as Auto mode is shown
 * it: the latest prompt that user sent there, which the Fast turn persists
 * before it runs. Prompts from anyone else in the conversation never match.
 */
export async function findLatestFastConversationUserRequest(input: {
  conversationId: string;
  userId: string;
}): Promise<string | undefined> {
  const [latest] = await db
    .select({
      contentBlocks: fastAgentMessages.contentBlocks,
      payload: fastAgentMessages.payload,
    })
    .from(fastAgentMessages)
    .where(
      and(
        eq(fastAgentMessages.conversationId, input.conversationId),
        eq(fastAgentMessages.role, 'user'),
        eq(fastAgentMessages.eventType, ACP_ENVELOPE_EVENT_TYPES.UserPrompt),
        sql`${fastAgentMessages.metadata}->>'userId' = ${input.userId}`,
      ),
    )
    .orderBy(
      desc(fastAgentMessages.ts),
      desc(fastAgentMessages.turnSeq),
      desc(fastAgentMessages.createdAt),
    )
    .limit(1);
  if (!latest) return undefined;
  return toIntegrationToolUserRequest(
    extractAcpMessageText(
      latest.contentBlocks,
      asRecord(latest.payload) ?? null,
    ),
  );
}
