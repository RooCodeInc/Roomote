import { and, eq, isNull, sql } from 'drizzle-orm';

import { ACP_ENVELOPE_EVENT_TYPES } from '@roomote/types';

import { db } from '../db';
import { fastAgentMessages, taskMessages, users } from '../schema';

/** Who sent a set of prompts: nobody yet, one person, or several. */
type PromptSenders =
  | { kind: 'none' }
  | { kind: 'one'; userId: string }
  | { kind: 'several' };

/**
 * Who sent the human prompts of a session's conversation, over all of them
 * rather than the recent ones a caller shows. A prompt without a recorded
 * sender counts as several, so the answer is "one" only when every prompt is
 * known to be that person's. A chat sender with no account of their own acts
 * under another user's id, so the chat identity has to be the same throughout
 * as well.
 */
export async function findSessionPromptSenders(
  conversationId: string,
): Promise<PromptSenders> {
  const rows = await db
    .selectDistinct({
      userId: sql<string | null>`${fastAgentMessages.metadata}->>'userId'`,
      externalId: sql<string>`coalesce(${fastAgentMessages.metadata}->>'senderExternalId', '')`,
    })
    .from(fastAgentMessages)
    .where(
      and(
        eq(fastAgentMessages.conversationId, conversationId),
        eq(fastAgentMessages.eventType, ACP_ENVELOPE_EVENT_TYPES.UserPrompt),
        eq(fastAgentMessages.role, 'user'),
        sql`${fastAgentMessages.metadata}->>'turnSource' = 'human'`,
      ),
    )
    .limit(2);
  const [only, another] = rows;
  if (!only) return { kind: 'none' };
  return another || !only.userId
    ? { kind: 'several' }
    : { kind: 'one', userId: only.userId };
}

/**
 * Who sent the prompts people sent to a task itself, over all of them: an
 * earlier prompt from somebody else still makes the task a shared one after
 * it has left the recent history. Prompts the platform or the harness sends
 * carry no sender and are not counted. These rows are recorded by the task's
 * own worker.
 */
export async function findTaskPromptSenders(
  taskId: string,
): Promise<PromptSenders> {
  const rows = await db
    .selectDistinct({
      userId: sql<string>`${taskMessages.metadata}->>'userId'`,
      externalId: sql<string>`coalesce(${taskMessages.metadata}->>'senderExternalId', '')`,
    })
    .from(taskMessages)
    .where(
      and(
        eq(taskMessages.taskId, taskId),
        eq(taskMessages.eventType, ACP_ENVELOPE_EVENT_TYPES.UserPrompt),
        sql`${taskMessages.metadata}->>'userId' is not null`,
      ),
    )
    .limit(2);
  const [only, another] = rows;
  if (!only) return { kind: 'none' };
  return another ? { kind: 'several' } : { kind: 'one', userId: only.userId };
}

/**
 * The session owner as Auto is told about them: the name and email on their
 * account. Auto uses it to tell a call that names the owner from one that
 * names somebody else.
 */
export async function getIntegrationToolAutoOwner(
  userId: string,
): Promise<{ name?: string; email?: string } | undefined> {
  const [user] = await db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  if (!user) return undefined;
  const name = user.name.trim();
  const email = user.email.trim();
  if (!name && !email) return undefined;
  return { ...(name ? { name } : {}), ...(email ? { email } : {}) };
}

/**
 * The owner of a session whose every human prompt they sent themselves, so
 * "me" in those prompts is the owner. Undefined when anybody else wrote one,
 * or a sender is unknown: then nothing says who "me" is.
 */
export async function resolveSessionIntegrationToolAutoOwner(input: {
  conversationId: string;
  ownerUserId: string;
}): Promise<{ name?: string; email?: string } | undefined> {
  const senders = await findSessionPromptSenders(input.conversationId);
  if (senders.kind !== 'one' || senders.userId !== input.ownerUserId) {
    return undefined;
  }
  return getIntegrationToolAutoOwner(input.ownerUserId);
}
