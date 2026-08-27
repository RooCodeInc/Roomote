import { describe, expect, it } from 'vitest';

import { db, fastAgentConversations, userFactory } from '@roomote/db/server';

import {
  findFastAgentSessionForProviderReply,
  isFastAgentProviderMessage,
  recordFastAgentProviderMessage,
} from './fast-agent-provider-message';

async function createFastConversation(input: {
  surface: 'discord' | 'teams';
  workspaceId: string;
  conversationId: string;
  channelId: string;
  threadId?: string;
}) {
  const user = await userFactory.create();
  const [conversation] = await db
    .insert(fastAgentConversations)
    .values({
      userId: user.id,
      surface: input.surface,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      currentReplyChannelId: input.channelId,
      currentReplyThreadId: input.threadId ?? null,
    })
    .returning();
  return { user, conversation: conversation! };
}

describe('Fast provider message bindings', () => {
  it('resolves a Discord DM reply to the bound Fast session', async () => {
    const suffix = crypto.randomUUID();
    const { user, conversation } = await createFastConversation({
      surface: 'discord',
      workspaceId: 'dm',
      conversationId: `automation:${suffix}`,
      channelId: `dm:${suffix}`,
    });

    await recordFastAgentProviderMessage({
      sessionId: conversation.id,
      provider: 'discord',
      workspaceId: 'dm',
      channelId: `dm:${suffix}`,
      messageId: `message:${suffix}`,
    });

    const session = await findFastAgentSessionForProviderReply({
      provider: 'discord',
      workspaceId: 'dm',
      channelId: `dm:${suffix}`,
      replyToMessageId: `message:${suffix}`,
    });
    expect(session).toMatchObject({ id: conversation.id, userId: user.id });
  });

  it('fails closed when a Teams message is replayed from another tenant', async () => {
    const suffix = crypto.randomUUID();
    const { conversation } = await createFastConversation({
      surface: 'teams',
      workspaceId: `tenant:${suffix}`,
      conversationId: `automation:${suffix}`,
      channelId: `conversation:${suffix}`,
      threadId: `root:${suffix}`,
    });
    await recordFastAgentProviderMessage({
      sessionId: conversation.id,
      provider: 'teams',
      workspaceId: `tenant:${suffix}`,
      channelId: `conversation:${suffix}`,
      threadId: `root:${suffix}`,
      messageId: `message:${suffix}`,
    });

    await expect(
      findFastAgentSessionForProviderReply({
        provider: 'teams',
        workspaceId: `other-tenant:${suffix}`,
        channelId: `conversation:${suffix}`,
        threadId: `root:${suffix}`,
        replyToMessageId: `message:${suffix}`,
      }),
    ).resolves.toBeNull();
    await expect(
      isFastAgentProviderMessage({
        provider: 'teams',
        messageId: `message:${suffix}`,
      }),
    ).resolves.toBe(true);
  });

  it('resolves a provider thread without requiring a reply reference', async () => {
    const suffix = crypto.randomUUID();
    const { conversation } = await createFastConversation({
      surface: 'teams',
      workspaceId: `tenant:${suffix}`,
      conversationId: `automation:${suffix}`,
      channelId: `conversation:${suffix}`,
      threadId: `root:${suffix}`,
    });

    const session = await findFastAgentSessionForProviderReply({
      provider: 'teams',
      workspaceId: `tenant:${suffix}`,
      channelId: `conversation:${suffix}`,
      threadId: `root:${suffix}`,
    });
    expect(session?.id).toBe(conversation.id);
  });

  it('resolves a Teams personal-chat reply without treating replyToId as a session thread', async () => {
    const suffix = crypto.randomUUID();
    const { conversation } = await createFastConversation({
      surface: 'teams',
      workspaceId: `tenant:${suffix}`,
      conversationId: `automation:${suffix}`,
      channelId: `chat:${suffix}`,
    });
    await recordFastAgentProviderMessage({
      sessionId: conversation.id,
      provider: 'teams',
      workspaceId: `tenant:${suffix}`,
      channelId: `chat:${suffix}`,
      messageId: `message:${suffix}`,
    });

    const session = await findFastAgentSessionForProviderReply({
      provider: 'teams',
      workspaceId: `tenant:${suffix}`,
      channelId: `chat:${suffix}`,
      threadId: `message:${suffix}`,
      replyToMessageId: `message:${suffix}`,
    });
    expect(session?.id).toBe(conversation.id);
  });
});
