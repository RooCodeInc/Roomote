import type { ModelMessage } from 'ai';
import {
  and,
  desc,
  db,
  eq,
  isNull,
  or,
  slackQuickAnswers,
  sql,
  taskRuns,
  tasks,
  type SlackQuickAnswer,
} from '@roomote/db/server';
import { activeRunStatuses, type RunStatus } from '@roomote/types';

type FastAgentSessionRecord = Pick<SlackQuickAnswer, 'id'> & {
  messages: ModelMessage[];
};

export type FastAgentActiveTask = {
  taskId: string;
  title?: string;
  status?: RunStatus;
};

function buildFastAgentSessionWhere({
  slackTeamId,
  slackChannel,
  slackThreadTs,
}: {
  slackTeamId: string;
  slackChannel: string;
  slackThreadTs: string;
}) {
  const scopedSlackChannel = buildFastAgentSessionChannelKey({
    slackTeamId,
    slackChannel,
  });

  return and(
    eq(slackQuickAnswers.slackChannel, scopedSlackChannel),
    eq(slackQuickAnswers.slackThreadTs, slackThreadTs),
  );
}

export function buildFastAgentSessionChannelKey({
  slackTeamId,
  slackChannel,
}: {
  slackTeamId: string;
  slackChannel: string;
}): string {
  // The existing column and unique index predate multi-workspace scoping.
  // Qualifying the value keeps N-1 rollback compatibility without a migration.
  return `${slackTeamId}:${slackChannel}`;
}

export async function getOrCreateFastAgentSession({
  userId,
  slackTeamId,
  slackChannel,
  slackThreadTs,
}: {
  userId: string;
  slackTeamId: string;
  slackChannel: string;
  slackThreadTs: string;
}): Promise<FastAgentSessionRecord> {
  const where = buildFastAgentSessionWhere({
    slackTeamId,
    slackChannel,
    slackThreadTs,
  });
  const scopedSlackChannel = buildFastAgentSessionChannelKey({
    slackTeamId,
    slackChannel,
  });

  const existingSession = await db.query.slackQuickAnswers.findFirst({
    where,
    columns: {
      id: true,
      messages: true,
    },
  });

  if (existingSession) {
    return {
      id: existingSession.id,
      messages: existingSession.messages as ModelMessage[],
    };
  }

  const [createdSession] = await db
    .insert(slackQuickAnswers)
    .values({
      userId,
      slackChannel: scopedSlackChannel,
      slackThreadTs,
      messages: [],
    })
    .onConflictDoNothing({
      target: [slackQuickAnswers.slackChannel, slackQuickAnswers.slackThreadTs],
    })
    .returning({
      id: slackQuickAnswers.id,
      messages: slackQuickAnswers.messages,
    });

  if (createdSession) {
    return {
      id: createdSession.id,
      messages: createdSession.messages as ModelMessage[],
    };
  }

  const concurrentSession = await db.query.slackQuickAnswers.findFirst({
    where,
    columns: {
      id: true,
      messages: true,
    },
  });

  if (!concurrentSession) {
    throw new Error('Failed to create or load fast-agent session.');
  }

  return {
    id: concurrentSession.id,
    messages: concurrentSession.messages as ModelMessage[],
  };
}

export async function hasFastAgentSession({
  slackTeamId,
  slackChannel,
  slackThreadTs,
}: {
  slackTeamId: string;
  slackChannel: string;
  slackThreadTs: string;
}): Promise<boolean> {
  const session = await db.query.slackQuickAnswers.findFirst({
    where: buildFastAgentSessionWhere({
      slackTeamId,
      slackChannel,
      slackThreadTs,
    }),
    columns: { id: true },
  });

  return Boolean(session);
}

export async function getActiveFastAgentTasks(
  sessionId: string,
): Promise<FastAgentActiveTask[]> {
  const activeRuns = await db
    .select({
      taskId: taskRuns.taskId,
      title: tasks.title,
      status: taskRuns.status,
      canceledAt: taskRuns.canceledAt,
    })
    .from(taskRuns)
    .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
    .where(
      and(
        or(
          sql`${taskRuns.payload} -> 'fastAgentParent' ->> 'sessionId' = ${sessionId}`,
          sql`${taskRuns.payload} ->> 'fastAgentSessionId' = ${sessionId}`,
        ),
        isNull(tasks.deletedAt),
      ),
    )
    .orderBy(desc(taskRuns.createdAt));

  const tasksById = new Map<string, FastAgentActiveTask>();
  const seenTaskIds = new Set<string>();
  for (const run of activeRuns) {
    if (seenTaskIds.has(run.taskId)) {
      continue;
    }
    seenTaskIds.add(run.taskId);

    if (
      !run.canceledAt &&
      activeRunStatuses.some((status) => status === run.status)
    ) {
      tasksById.set(run.taskId, {
        taskId: run.taskId,
        title: run.title,
        status: run.status,
      });
    }
  }

  return [...tasksById.values()];
}

export async function appendFastAgentSessionMessages({
  sessionId,
  messages,
}: {
  sessionId: string;
  messages: ModelMessage[];
}): Promise<void> {
  if (messages.length === 0) {
    return;
  }

  await db
    .update(slackQuickAnswers)
    .set({
      messages: sql`${slackQuickAnswers.messages} || ${JSON.stringify(messages)}::jsonb`,
      updatedAt: sql`now()`,
    })
    .where(eq(slackQuickAnswers.id, sessionId));
}
