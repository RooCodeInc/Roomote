import { describe, expect, it } from 'vitest';

import { db, fastAgentConversations, userFactory } from '@roomote/db/server';

import {
  findFastAgentSessionForProviderReply,
  isFastAgentProviderMessage,
  recordFastAgentProviderMessage,
} from './fast-agent-provider-message';

async function createFastConversation(input: {
  surface: 'discord' | 'slack' | 'teams' | 'telegram';
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
  it('resolves a Slack reaction target to its bound Fast session owner', async () => {
    const suffix = crypto.randomUUID();
    const { user, conversation } = await createFastConversation({
      surface: 'slack',
      workspaceId: `team:${suffix}`,
      conversationId: `thread:${suffix}`,
      channelId: `channel:${suffix}`,
      threadId: `thread:${suffix}`,
    });
    await recordFastAgentProviderMessage({
      sessionId: conversation.id,
      provider: 'slack',
      workspaceId: `team:${suffix}`,
      channelId: `channel:${suffix}`,
      threadId: `thread:${suffix}`,
      messageId: `message:${suffix}`,
    });

    await expect(
      findFastAgentSessionForProviderReply({
        provider: 'slack',
        workspaceId: `team:${suffix}`,
        channelId: `channel:${suffix}`,
        replyToMessageId: `message:${suffix}`,
        userId: user.id,
      }),
    ).resolves.toMatchObject({ id: conversation.id, userId: user.id });
  });

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

  it('resolves a shared provider thread to the requesting user session', async () => {
    const suffix = crypto.randomUUID();
    const route = {
      surface: 'teams' as const,
      workspaceId: `tenant:${suffix}`,
      channelId: `conversation:${suffix}`,
      threadId: `root:${suffix}`,
    };
    const first = await createFastConversation({
      ...route,
      conversationId: `first:${suffix}`,
    });
    const second = await createFastConversation({
      ...route,
      conversationId: `second:${suffix}`,
    });

    await expect(
      findFastAgentSessionForProviderReply({
        provider: 'teams',
        workspaceId: route.workspaceId,
        channelId: route.channelId,
        threadId: route.threadId,
        userId: second.user.id,
      }),
    ).resolves.toMatchObject({
      id: second.conversation.id,
      userId: second.user.id,
    });
    await expect(
      findFastAgentSessionForProviderReply({
        provider: 'teams',
        workspaceId: route.workspaceId,
        channelId: route.channelId,
        threadId: route.threadId,
        userId: first.user.id,
      }),
    ).resolves.toMatchObject({
      id: first.conversation.id,
      userId: first.user.id,
    });
  });

  it('rejects a provider-message binding owned by another user', async () => {
    const suffix = crypto.randomUUID();
    const first = await createFastConversation({
      surface: 'teams',
      workspaceId: `tenant:${suffix}`,
      conversationId: `first:${suffix}`,
      channelId: `conversation:${suffix}`,
      threadId: `root:${suffix}`,
    });
    const secondUser = await userFactory.create();
    await recordFastAgentProviderMessage({
      sessionId: first.conversation.id,
      provider: 'teams',
      workspaceId: `tenant:${suffix}`,
      channelId: `conversation:${suffix}`,
      threadId: `root:${suffix}`,
      messageId: `message:${suffix}`,
    });

    await expect(
      findFastAgentSessionForProviderReply({
        provider: 'teams',
        workspaceId: `tenant:${suffix}`,
        channelId: `conversation:${suffix}`,
        threadId: `root:${suffix}`,
        replyToMessageId: `message:${suffix}`,
        userId: secondUser.id,
      }),
    ).resolves.toBeNull();
  });

  it('binds Telegram replies to the originating Fast session', async () => {
    const suffix = crypto.randomUUID();
    const { user, conversation } = await createFastConversation({
      surface: 'telegram',
      workspaceId: `chat:${suffix}`,
      conversationId: `topic:${suffix}:user:${suffix}`,
      channelId: `chat:${suffix}`,
      threadId: `topic:${suffix}`,
    });
    await recordFastAgentProviderMessage({
      sessionId: conversation.id,
      provider: 'telegram',
      workspaceId: `chat:${suffix}`,
      channelId: `chat:${suffix}`,
      threadId: `topic:${suffix}`,
      messageId: `message:${suffix}`,
    });

    await expect(
      findFastAgentSessionForProviderReply({
        provider: 'telegram',
        workspaceId: `chat:${suffix}`,
        channelId: `chat:${suffix}`,
        threadId: `topic:${suffix}`,
        replyToMessageId: `message:${suffix}`,
        userId: user.id,
      }),
    ).resolves.toMatchObject({ id: conversation.id, userId: user.id });
  });

  it('scopes Telegram message detection to its chat', async () => {
    const suffix = crypto.randomUUID();
    const { conversation } = await createFastConversation({
      surface: 'telegram',
      workspaceId: `chat:${suffix}`,
      conversationId: `chat:${suffix}:user:${suffix}`,
      channelId: `chat:${suffix}`,
    });
    await recordFastAgentProviderMessage({
      sessionId: conversation.id,
      provider: 'telegram',
      workspaceId: `chat:${suffix}`,
      channelId: `chat:${suffix}`,
      messageId: '42',
    });

    await expect(
      isFastAgentProviderMessage({
        provider: 'telegram',
        messageId: '42',
        workspaceId: `other-chat:${suffix}`,
        channelId: `other-chat:${suffix}`,
      }),
    ).resolves.toBe(false);
    await expect(
      isFastAgentProviderMessage({
        provider: 'telegram',
        messageId: '42',
        workspaceId: `chat:${suffix}`,
        channelId: `chat:${suffix}`,
      }),
    ).resolves.toBe(true);
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
