import {
  and,
  db,
  eq,
  slackConversationMessages,
  slackUserMappings,
} from '@roomote/db/server';

type SlackConversationSubject = {
  subjectUserId: string | null;
  slackTeamId: string;
  subjectSlackUserId: string;
};

type SlackConversationDirection = 'inbound' | 'outbound';
type SlackConversationAuthorKind = 'roomote' | 'user' | 'admin' | 'system';
type SlackConversationKind = 'dm' | 'thread';

export type SlackConversationLogInput = SlackConversationSubject & {
  senderUserId?: string | null;
  senderSlackUserId?: string | null;
  slackChannelId: string;
  conversationKind: SlackConversationKind;
  threadTs?: string | null;
  messageTs: string;
  direction: SlackConversationDirection;
  authorKind: SlackConversationAuthorKind;
  source: string;
  text?: string | null;
  metadata?: Record<string, unknown>;
  taskId?: string | null;
  cloudJobId?: number | null;
  slackQuickAnswerId?: string | null;
};

function toSlackMessageAt(messageTs: string): Date {
  const parsed = Number(messageTs);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return new Date();
  }

  return new Date(parsed * 1000);
}

export async function findSlackConversationSubjectByUserId(input: {
  userId: string;
  slackTeamId: string;
}): Promise<SlackConversationSubject | null> {
  const mapping = await db.query.slackUserMappings.findFirst({
    columns: {
      userId: true,
      slackTeamId: true,
      slackUserId: true,
    },
    where: and(
      eq(slackUserMappings.userId, input.userId),
      eq(slackUserMappings.slackTeamId, input.slackTeamId),
    ),
  });

  if (!mapping) {
    return null;
  }

  return {
    subjectUserId: mapping.userId,
    slackTeamId: mapping.slackTeamId,
    subjectSlackUserId: mapping.slackUserId,
  };
}

export async function recordSlackConversationMessage(
  input: SlackConversationLogInput,
): Promise<void> {
  await db
    .insert(slackConversationMessages)
    .values({
      subjectUserId: input.subjectUserId,
      slackTeamId: input.slackTeamId,
      subjectSlackUserId: input.subjectSlackUserId,
      senderUserId: input.senderUserId ?? null,
      senderSlackUserId: input.senderSlackUserId ?? null,
      slackChannelId: input.slackChannelId,
      conversationKind: input.conversationKind,
      threadTs: input.threadTs ?? null,
      messageTs: input.messageTs,
      messageAt: toSlackMessageAt(input.messageTs),
      direction: input.direction,
      authorKind: input.authorKind,
      source: input.source,
      text: input.text?.trim() ?? '',
      metadata: input.metadata ?? {},
      taskId: input.taskId ?? null,
      runId: input.cloudJobId ?? null,
      slackQuickAnswerId: input.slackQuickAnswerId ?? null,
    })
    .onConflictDoNothing();
}

export async function recordSlackConversationMessageBestEffort(
  input: SlackConversationLogInput & {
    logContext: string;
  },
): Promise<void> {
  try {
    await recordSlackConversationMessage(input);
  } catch (error) {
    console.warn(
      `[${input.logContext}] Failed to record Slack conversation message: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
