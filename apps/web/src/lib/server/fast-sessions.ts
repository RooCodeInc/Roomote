import {
  and,
  db,
  desc,
  eq,
  fastAgentConversations,
  sql,
  users,
} from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

type FastSessionAuth = Pick<UserAuthSuccess, 'userId' | 'isAdmin'>;

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
  messageCount: sql<number>`jsonb_array_length(${fastAgentConversations.compatibilityMessages})`,
  createdAt: fastAgentConversations.createdAt,
  updatedAt: fastAgentConversations.updatedAt,
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
    .select(fastSessionSelection)
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

  return session ?? null;
}
