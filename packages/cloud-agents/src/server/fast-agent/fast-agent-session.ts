import type { ModelMessage } from 'ai';
import {
  and,
  db,
  eq,
  fastAgentSessions,
  sql,
  type FastAgentSession,
} from '@roomote/db/server';

type FastAgentSessionRecord = Pick<FastAgentSession, 'id'> & {
  messages: ModelMessage[];
};

function buildFastAgentSessionWhere({
  slackChannel,
  slackThreadTs,
}: {
  slackChannel: string;
  slackThreadTs: string;
}) {
  return and(
    eq(fastAgentSessions.slackChannel, slackChannel),
    eq(fastAgentSessions.slackThreadTs, slackThreadTs),
  );
}

export async function getOrCreateFastAgentSession({
  userId,
  slackChannel,
  slackThreadTs,
}: {
  userId: string;
  slackChannel: string;
  slackThreadTs: string;
}): Promise<FastAgentSessionRecord> {
  const where = buildFastAgentSessionWhere({
    slackChannel,
    slackThreadTs,
  });

  const existingSession = await db.query.fastAgentSessions.findFirst({
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
    .insert(fastAgentSessions)
    .values({
      userId,
      slackChannel,
      slackThreadTs,
      messages: [],
    })
    .onConflictDoNothing({
      target: [fastAgentSessions.slackChannel, fastAgentSessions.slackThreadTs],
    })
    .returning({
      id: fastAgentSessions.id,
      messages: fastAgentSessions.messages,
    });

  if (createdSession) {
    return {
      id: createdSession.id,
      messages: createdSession.messages as ModelMessage[],
    };
  }

  const concurrentSession = await db.query.fastAgentSessions.findFirst({
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
    .update(fastAgentSessions)
    .set({
      messages: sql`${fastAgentSessions.messages} || ${JSON.stringify(messages)}::jsonb`,
      updatedAt: sql`now()`,
    })
    .where(eq(fastAgentSessions.id, sessionId));
}
