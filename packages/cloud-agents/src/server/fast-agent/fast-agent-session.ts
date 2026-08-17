import type { ModelMessage } from 'ai';
import {
  and,
  desc,
  db,
  eq,
  inArray,
  isNull,
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
  const latestRunPerTask = db.$with('latest_fast_agent_task_runs').as(
    db
      .selectDistinctOn([taskRuns.taskId], {
        runId: taskRuns.id,
        createdAt: taskRuns.createdAt,
        taskId: taskRuns.taskId,
        title: tasks.title,
        status: taskRuns.status,
        canceledAt: taskRuns.canceledAt,
      })
      .from(taskRuns)
      .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
      .where(
        and(
          eq(taskRuns.fastAgentSessionId, sessionId),
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
      and(
        inArray(latestRunPerTask.status, [...activeRunStatuses]),
        isNull(latestRunPerTask.canceledAt),
      ),
    )
    .orderBy(desc(latestRunPerTask.createdAt));
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
