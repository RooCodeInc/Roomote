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
import type { RunStatus } from '@roomote/types';
import type { FastAgentConversation } from './fast-agent-conversation';
import { fastAgentConversationRepository } from './fast-agent-conversation-repository';

type FastAgentSessionRecord = {
  id: string;
  compatibilityMessages: ModelMessage[];
  openCodeSessionId: string | null;
};

export type FastAgentActiveTask = {
  taskId: string;
  title?: string;
  status?: RunStatus;
};

export async function getOrCreateFastAgentSession({
  userId,
  conversation,
}: {
  userId: string;
  conversation: FastAgentConversation;
}): Promise<FastAgentSessionRecord> {
  return fastAgentConversationRepository.getOrCreate({ userId, conversation });
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
