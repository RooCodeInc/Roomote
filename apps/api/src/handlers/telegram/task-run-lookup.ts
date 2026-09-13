import {
  findActiveCommunicationTaskRun,
  findCompletedCommunicationTaskRunWithSnapshot,
  findTaskBackedAutomationReportRun,
} from '@roomote/sdk/server/communication';
import { activeRunStatuses } from '@roomote/types';
import {
  and,
  db,
  desc,
  eq,
  fastAgentConversations,
  inArray,
  isNull,
  sessions,
  sessionTasks,
  taskRuns,
  tasks,
} from '@roomote/db/server';
import type { TelegramConversationRef } from './types.js';

export async function findActiveTelegramTaskRun(
  input: TelegramConversationRef,
) {
  return findActiveCommunicationTaskRun({
    provider: 'telegram',
    channelId: input.chatId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
  });
}

export async function findActiveTelegramSessionTaskRun(
  input: TelegramConversationRef & { userId: string },
) {
  const [run] = await db
    .select({ id: taskRuns.id, taskId: taskRuns.taskId })
    .from(fastAgentConversations)
    .innerJoin(
      sessions,
      eq(sessions.fastConversationId, fastAgentConversations.id),
    )
    .innerJoin(sessionTasks, eq(sessionTasks.sessionId, sessions.id))
    .innerJoin(tasks, eq(tasks.id, sessionTasks.taskId))
    .innerJoin(taskRuns, eq(taskRuns.taskId, tasks.id))
    .where(
      and(
        eq(fastAgentConversations.surface, 'telegram'),
        eq(fastAgentConversations.workspaceId, input.chatId),
        eq(fastAgentConversations.currentReplyChannelId, input.chatId),
        input.threadId
          ? eq(fastAgentConversations.currentReplyThreadId, input.threadId)
          : isNull(fastAgentConversations.currentReplyThreadId),
        eq(fastAgentConversations.userId, input.userId),
        eq(tasks.state, 'active'),
        inArray(taskRuns.status, [...activeRunStatuses]),
        isNull(taskRuns.canceledAt),
        isNull(tasks.deletedAt),
      ),
    )
    .orderBy(desc(taskRuns.createdAt))
    .limit(1);

  return run;
}

export async function findCompletedTelegramTaskRunWithSnapshot(
  input: TelegramConversationRef,
) {
  return findCompletedCommunicationTaskRunWithSnapshot({
    provider: 'telegram',
    channelId: input.chatId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
  });
}

export async function findTelegramAutomationReportRun(input: {
  chatId: string;
  messageId: string;
}) {
  return findTaskBackedAutomationReportRun({
    provider: 'telegram',
    channelId: input.chatId,
    messageId: input.messageId,
  });
}

export type CompletedTelegramTaskRun = NonNullable<
  Awaited<ReturnType<typeof findCompletedTelegramTaskRunWithSnapshot>>
>;
