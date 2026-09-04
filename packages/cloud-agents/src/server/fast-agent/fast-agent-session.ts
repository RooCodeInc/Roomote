import type { ModelMessage } from 'ai';
import {
  and,
  desc,
  db,
  eq,
  inArray,
  isTaskRunFollowUpCandidate,
  isNull,
  taskRuns,
  tasks,
} from '@roomote/db/server';
import type { FastAgentConversationOwner, RunStatus } from '@roomote/types';
import type { FastAgentConversation } from './fast-agent-conversation';
import { fastAgentConversationRepository } from './fast-agent-conversation-repository';
import type {
  FastAgentMessageUpsertResult,
  FastAgentMessageWrite,
} from './fast-agent-conversation-repository';

type FastAgentSessionRecord = {
  id: string;
  userId: string | null;
  owner: FastAgentConversationOwner;
  title: string | null;
  conversation: FastAgentConversation;
  compatibilityMessages: ModelMessage[];
  openCodeSessionId: string | null;
  created: boolean;
};

export type FastAgentActiveTask = {
  taskId: string;
  title?: string;
  status?: RunStatus;
};

export async function getOrCreateFastAgentSession({
  owner,
  userId,
  conversation,
  sessionId,
  initialTitle,
}: {
  owner?: FastAgentConversationOwner;
  userId?: string;
  conversation: FastAgentConversation;
  /** Session to bind a newly created conversation to; see the repository. */
  sessionId?: string;
  /** Title to seed only when this call creates the conversation. */
  initialTitle?: string;
}): Promise<FastAgentSessionRecord> {
  return fastAgentConversationRepository.getOrCreate({
    ...(owner ? { owner } : {}),
    ...(userId ? { userId } : {}),
    conversation,
    ...(sessionId ? { sessionId } : {}),
    ...(initialTitle ? { initialTitle } : {}),
  });
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
        vendor: taskRuns.vendor,
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
        vendor: latestRunPerTask.vendor,
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
