import {
  and,
  asc,
  db,
  desc,
  eq,
  fastAgentConversations,
  fastAgentMessages,
  sql,
  users,
} from '@roomote/db/server';
import type { FastAgentMessage } from '@roomote/db';

import type { UserAuthSuccess } from '@/types';

type FastSessionAuth = Pick<UserAuthSuccess, 'userId' | 'isAdmin'>;

export type FastSessionMessage = Pick<
  FastAgentMessage,
  | 'id'
  | 'eventId'
  | 'turnId'
  | 'turnSeq'
  | 'ts'
  | 'eventType'
  | 'role'
  | 'contentBlocks'
  | 'metadata'
  | 'payload'
  | 'source'
  | 'nativeSessionId'
  | 'nativeMessageId'
  | 'createdAt'
>;

const fastSessionSelection = {
  id: fastAgentConversations.id,
  userId: fastAgentConversations.userId,
  ownerName: users.name,
  ownerEmail: users.email,
  surface: fastAgentConversations.surface,
  workspaceId: fastAgentConversations.workspaceId,
  conversationId: fastAgentConversations.conversationId,
  currentReplyChannelId: fastAgentConversations.currentReplyChannelId,
  currentReplyThreadId: fastAgentConversations.currentReplyThreadId,
  replyTargetVerified: fastAgentConversations.replyTargetVerified,
  openCodeSessionId: fastAgentConversations.openCodeSessionId,
  messageCount: sql<number>`(
    select count(*)::int
    from ${fastAgentMessages}
    where ${fastAgentMessages.conversationId} = ${fastAgentConversations.id}
  )`,
  createdAt: fastAgentConversations.createdAt,
  updatedAt: fastAgentConversations.updatedAt,
};

const fastSessionDetailSelection = {
  ...fastSessionSelection,
};

function fastSessionScope(auth: FastSessionAuth) {
  return auth.isAdmin
    ? undefined
    : eq(fastAgentConversations.userId, auth.userId);
}

export async function getFastSessions(auth: FastSessionAuth) {
  return db
    .select(fastSessionSelection)
    .from(fastAgentConversations)
    .innerJoin(users, eq(fastAgentConversations.userId, users.id))
    .where(fastSessionScope(auth))
    .orderBy(
      desc(fastAgentConversations.updatedAt),
      desc(fastAgentConversations.id),
    );
}

export async function getFastSessionById(
  auth: FastSessionAuth,
  sessionId: string,
) {
  const [session] = await db
    .select(fastSessionDetailSelection)
    .from(fastAgentConversations)
    .innerJoin(users, eq(fastAgentConversations.userId, users.id))
    .where(
      auth.isAdmin
        ? eq(fastAgentConversations.id, sessionId)
        : and(
            eq(fastAgentConversations.id, sessionId),
            eq(fastAgentConversations.userId, auth.userId),
          ),
    )
    .limit(1);

  if (!session) {
    return null;
  }

  const messages = await db
    .select({
      id: fastAgentMessages.id,
      eventId: fastAgentMessages.eventId,
      turnId: fastAgentMessages.turnId,
      turnSeq: fastAgentMessages.turnSeq,
      ts: fastAgentMessages.ts,
      eventType: fastAgentMessages.eventType,
      role: fastAgentMessages.role,
      contentBlocks: fastAgentMessages.contentBlocks,
      metadata: fastAgentMessages.metadata,
      payload: fastAgentMessages.payload,
      source: fastAgentMessages.source,
      nativeSessionId: fastAgentMessages.nativeSessionId,
      nativeMessageId: fastAgentMessages.nativeMessageId,
      createdAt: fastAgentMessages.createdAt,
    })
    .from(fastAgentMessages)
    .where(eq(fastAgentMessages.conversationId, session.id))
    .orderBy(
      asc(fastAgentMessages.ts),
      asc(fastAgentMessages.turnSeq),
      asc(fastAgentMessages.createdAt),
      asc(fastAgentMessages.id),
    );

  return {
    ...session,
    messages,
  };
}
