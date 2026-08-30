import {
  and,
  db,
  eq,
  fastAgentConversations,
  fastAgentProviderMessages,
} from '@roomote/db/server';
import {
  fastAgentConversationRepository,
  type FastAgentConversation,
  type FastAgentConversationRecord,
} from '@roomote/cloud-agents/server';

export type FastAgentReplyProvider = 'discord' | 'slack' | 'teams' | 'telegram';

type ProviderRoute = {
  provider: FastAgentReplyProvider;
  workspaceId: string;
  channelId: string;
  threadId?: string;
};

function matchesProviderRoute(
  record: FastAgentConversationRecord,
  route: ProviderRoute,
  requireThreadMatch = true,
): boolean {
  const conversation = record.conversation;
  return (
    conversation.surface === route.provider &&
    conversation.workspaceId === route.workspaceId &&
    conversation.replyTarget.channelId === route.channelId &&
    (!requireThreadMatch ||
      conversation.replyTarget.threadId === route.threadId)
  );
}

export async function recordFastAgentProviderMessage(
  input: ProviderRoute & { sessionId: string; messageId: string },
): Promise<boolean> {
  await db
    .insert(fastAgentProviderMessages)
    .values({
      conversationId: input.sessionId,
      provider: input.provider,
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      threadId: input.threadId ?? null,
      messageId: input.messageId,
    })
    .onConflictDoUpdate({
      target: [
        fastAgentProviderMessages.provider,
        fastAgentProviderMessages.workspaceId,
        fastAgentProviderMessages.channelId,
        fastAgentProviderMessages.messageId,
      ],
      set: {
        conversationId: input.sessionId,
        threadId: input.threadId ?? null,
        updatedAt: new Date(),
      },
    });
  return true;
}

export async function recordFastAgentConversationMessage(input: {
  sessionId: string;
  conversation: FastAgentConversation;
  messageId: string;
}): Promise<boolean> {
  const { conversation } = input;
  if (
    conversation.surface !== 'discord' &&
    conversation.surface !== 'slack' &&
    conversation.surface !== 'teams' &&
    conversation.surface !== 'telegram'
  ) {
    return false;
  }

  return recordFastAgentProviderMessage({
    sessionId: input.sessionId,
    provider: conversation.surface,
    workspaceId: conversation.workspaceId,
    channelId: conversation.replyTarget.channelId,
    ...(conversation.replyTarget.threadId
      ? { threadId: conversation.replyTarget.threadId }
      : {}),
    messageId: input.messageId,
  });
}

export async function recordFastAgentConversationMessageBestEffort(
  input: Parameters<typeof recordFastAgentConversationMessage>[0],
): Promise<void> {
  try {
    await recordFastAgentConversationMessage(input);
  } catch (error) {
    console.warn(
      `[fast-agent-provider-message] Failed to bind ${input.conversation.surface} message to Fast session ${input.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function findFastAgentSessionForProviderReply(
  input: ProviderRoute & { replyToMessageId?: string; userId?: string },
): Promise<FastAgentConversationRecord | null> {
  let conversationId: string | null = null;
  let matchedProviderMessage = false;

  if (input.replyToMessageId) {
    const binding = await db.query.fastAgentProviderMessages.findFirst({
      where: and(
        eq(fastAgentProviderMessages.provider, input.provider),
        eq(fastAgentProviderMessages.workspaceId, input.workspaceId),
        eq(fastAgentProviderMessages.channelId, input.channelId),
        eq(fastAgentProviderMessages.messageId, input.replyToMessageId),
      ),
      columns: { conversationId: true },
    });
    conversationId = binding?.conversationId ?? null;
    matchedProviderMessage = Boolean(binding);
  }

  if (!conversationId && input.threadId) {
    const conversation = await db.query.fastAgentConversations.findFirst({
      where: and(
        eq(fastAgentConversations.surface, input.provider),
        eq(fastAgentConversations.workspaceId, input.workspaceId),
        eq(fastAgentConversations.currentReplyChannelId, input.channelId),
        eq(fastAgentConversations.currentReplyThreadId, input.threadId),
        ...(input.userId
          ? [eq(fastAgentConversations.userId, input.userId)]
          : []),
      ),
      columns: { id: true },
    });
    conversationId = conversation?.id ?? null;
  }

  if (!conversationId) {
    return null;
  }

  const session = await fastAgentConversationRepository.findById({
    id: conversationId,
  });
  return session &&
    (!input.userId || session.userId === input.userId) &&
    matchesProviderRoute(session, input, !matchedProviderMessage)
    ? session
    : null;
}

export async function findFastAgentSessionForProviderMessage(
  input: ProviderRoute & { messageId: string; userId?: string },
): Promise<FastAgentConversationRecord | null> {
  const binding = await db.query.fastAgentProviderMessages.findFirst({
    where: and(
      eq(fastAgentProviderMessages.provider, input.provider),
      eq(fastAgentProviderMessages.workspaceId, input.workspaceId),
      eq(fastAgentProviderMessages.channelId, input.channelId),
      eq(fastAgentProviderMessages.messageId, input.messageId),
    ),
    columns: { conversationId: true, threadId: true },
  });
  if (
    !binding ||
    (input.threadId !== undefined && binding.threadId !== input.threadId)
  ) {
    return null;
  }

  const session = await fastAgentConversationRepository.findById({
    id: binding.conversationId,
  });
  return session &&
    (!input.userId || session.userId === input.userId) &&
    matchesProviderRoute(session, {
      ...input,
      ...(binding.threadId ? { threadId: binding.threadId } : {}),
    })
    ? session
    : null;
}

export async function isFastAgentProviderMessage(input: {
  provider: FastAgentReplyProvider;
  messageId: string;
  workspaceId?: string;
  channelId?: string;
}): Promise<boolean> {
  const binding = await db.query.fastAgentProviderMessages.findFirst({
    where: and(
      eq(fastAgentProviderMessages.provider, input.provider),
      eq(fastAgentProviderMessages.messageId, input.messageId),
      ...(input.workspaceId
        ? [eq(fastAgentProviderMessages.workspaceId, input.workspaceId)]
        : []),
      ...(input.channelId
        ? [eq(fastAgentProviderMessages.channelId, input.channelId)]
        : []),
    ),
    columns: { id: true },
  });
  return Boolean(binding);
}
