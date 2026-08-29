import type { ModelMessage } from 'ai';
import {
  and,
  desc,
  db,
  eq,
  fastAgentConversations,
  type FastAgentInitialTurn,
  inArray,
  isTaskRunFollowUpCandidate,
  isNull,
  taskRuns,
  tasks,
} from '@roomote/db/server';
import type { RunStatus } from '@roomote/types';
import type { FastAgentConversation } from './fast-agent-conversation';
import { fastAgentConversationRepository } from './fast-agent-conversation-repository';
import type {
  FastAgentMessageUpsertResult,
  FastAgentMessageWrite,
} from './fast-agent-conversation-repository';

type FastAgentSessionRecord = {
  id: string;
  title: string | null;
  conversation: FastAgentConversation;
  compatibilityMessages: ModelMessage[];
  openCodeSessionId: string | null;
  created: boolean;
  initialTurnPending: boolean;
};

export type FastAgentActiveTask = {
  taskId: string;
  title?: string;
  status?: RunStatus;
};

export async function getOrCreateFastAgentSession({
  userId,
  conversation,
  initialTurn,
}: {
  userId: string;
  conversation: FastAgentConversation;
  initialTurn?: FastAgentInitialTurn;
}): Promise<FastAgentSessionRecord> {
  return fastAgentConversationRepository.getOrCreate({
    userId,
    conversation,
    initialTurn,
  });
}

export async function getPendingFastAgentInitialTurn(
  sessionId: string,
): Promise<FastAgentInitialTurn | null> {
  const row = await db.query.fastAgentConversations.findFirst({
    where: eq(fastAgentConversations.id, sessionId),
    columns: { initialTurn: true, initialTurnCompletedAt: true },
  });
  return row?.initialTurn && !row.initialTurnCompletedAt
    ? row.initialTurn
    : null;
}

export async function completeFastAgentInitialTurn(
  sessionId: string,
): Promise<void> {
  await db
    .update(fastAgentConversations)
    .set({ initialTurnCompletedAt: new Date() })
    .where(eq(fastAgentConversations.id, sessionId));
}

export async function hasFastAgentSession(
  conversation: FastAgentConversation,
): Promise<boolean> {
  return fastAgentConversationRepository.exists(conversation);
}

export async function getActiveFastAgentTasks(
  sessionId: string,
): Promise<FastAgentActiveTask[]> {
  const lookupIds =
    await fastAgentConversationRepository.getLookupIds(sessionId);
  const latestRunPerTask = db.$with('latest_fast_agent_task_runs').as(
    db
      .selectDistinctOn([taskRuns.taskId], {
        runId: taskRuns.id,
        createdAt: taskRuns.createdAt,
        taskId: taskRuns.taskId,
        title: tasks.title,
        status: taskRuns.status,
        canceledAt: taskRuns.canceledAt,
        snapshotId: taskRuns.snapshotId,
        snapshotCreatedAt: taskRuns.snapshotCreatedAt,
        snapshotFailedAt: taskRuns.snapshotFailedAt,
      })
      .from(taskRuns)
      .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
      .where(
        and(
          inArray(taskRuns.fastAgentSessionId, lookupIds),
          isNull(tasks.deletedAt),
        ),
      )
      .orderBy(taskRuns.taskId, desc(taskRuns.createdAt), desc(taskRuns.id)),
  );

  return db
    .with(latestRunPerTask)
    .select({
      taskId: latestRunPerTask.taskId,
      title: latestRunPerTask.title,
      status: latestRunPerTask.status,
    })
    .from(latestRunPerTask)
    .where(
      isTaskRunFollowUpCandidate({
        status: latestRunPerTask.status,
        canceledAt: latestRunPerTask.canceledAt,
        snapshotId: latestRunPerTask.snapshotId,
        snapshotCreatedAt: latestRunPerTask.snapshotCreatedAt,
        snapshotFailedAt: latestRunPerTask.snapshotFailedAt,
      }),
    )
    .orderBy(desc(latestRunPerTask.createdAt));
}

export async function appendFastAgentVisibleMessages({
  sessionId,
  messages,
}: {
  sessionId: string;
  messages: ModelMessage[];
}): Promise<void> {
  if (messages.length === 0) {
    return;
  }

  await fastAgentConversationRepository.appendVisibleMessages({
    conversationId: sessionId,
    messages,
  });
}

export async function upsertFastAgentMessage({
  sessionId,
  message,
}: {
  sessionId: string;
  message: FastAgentMessageWrite;
}): Promise<FastAgentMessageUpsertResult> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fastAgentConversationRepository.upsertMessage({
        conversationId: sessionId,
        message,
      });
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

export async function setFastAgentOpenCodeSession({
  sessionId,
  openCodeSessionId,
}: {
  sessionId: string;
  openCodeSessionId: string;
}): Promise<void> {
  await fastAgentConversationRepository.setOpenCodeSession({
    conversationId: sessionId,
    openCodeSessionId,
  });
}
