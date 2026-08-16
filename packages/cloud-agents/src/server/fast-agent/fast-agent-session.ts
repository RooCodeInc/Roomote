import type { ModelMessage } from 'ai';
import {
  and,
  db,
  eq,
  slackQuickAnswers,
  sql,
  type SlackQuickAnswer,
} from '@roomote/db/server';

type FastAgentSessionRecord = Pick<SlackQuickAnswer, 'id'> & {
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
    eq(slackQuickAnswers.slackChannel, slackChannel),
    eq(slackQuickAnswers.slackThreadTs, slackThreadTs),
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
      slackChannel,
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
  slackChannel,
  slackThreadTs,
}: {
  slackChannel: string;
  slackThreadTs: string;
}): Promise<boolean> {
  const session = await db.query.slackQuickAnswers.findFirst({
    where: buildFastAgentSessionWhere({ slackChannel, slackThreadTs }),
    columns: { id: true },
  });

  return Boolean(session);
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
