import {
  and,
  db,
  desc,
  eq,
  fastAgentConversations,
  inArray,
  isNull,
  sql,
  taskRuns,
  tasks,
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

const fastSessionDetailSelection = {
  ...fastSessionSelection,
  compatibilityMessages: fastAgentConversations.compatibilityMessages,
  legacyConversationIds: fastAgentConversations.legacyConversationIds,
};

export type FastSessionTranscriptMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
};

function getPersistedText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .flatMap((part) =>
      part &&
      typeof part === 'object' &&
      'type' in part &&
      part.type === 'text' &&
      'text' in part &&
      typeof part.text === 'string'
        ? [part.text]
        : [],
    )
    .join('\n');
}

export function normalizeFastSessionTranscript(
  messages: Record<string, unknown>[],
): FastSessionTranscriptMessage[] {
  return messages.flatMap((message, index) => {
    if (message.role !== 'user' && message.role !== 'assistant') {
      return [];
    }

    const text = getPersistedText(message.content).trim();
    return text
      ? [{ id: `fast-message-${index}`, role: message.role, text }]
      : [];
  });
}

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

  const lookupIds = [session.id, ...session.legacyConversationIds];
  const latestRunPerTask = db.$with('latest_fast_session_task_runs').as(
    db
      .selectDistinctOn([taskRuns.taskId], {
        taskId: taskRuns.taskId,
        title: tasks.title,
        status: taskRuns.status,
        taskPhase: taskRuns.taskPhase,
        createdAt: taskRuns.createdAt,
      })
      .from(taskRuns)
      .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
      .where(
        and(
          inArray(taskRuns.fastAgentSessionId, lookupIds),
          eq(tasks.visibility, 'visible'),
          isNull(tasks.deletedAt),
        ),
      )
      .orderBy(taskRuns.taskId, desc(taskRuns.createdAt), desc(taskRuns.id)),
  );
  const linkedTasks = await db
    .with(latestRunPerTask)
    .select({
      taskId: latestRunPerTask.taskId,
      title: latestRunPerTask.title,
      status: latestRunPerTask.status,
      taskPhase: latestRunPerTask.taskPhase,
      createdAt: latestRunPerTask.createdAt,
    })
    .from(latestRunPerTask)
    .orderBy(desc(latestRunPerTask.createdAt));
  const {
    compatibilityMessages,
    legacyConversationIds: _,
    ...details
  } = session;

  return {
    ...details,
    transcript: normalizeFastSessionTranscript(compatibilityMessages),
    linkedTasks,
  };
}
