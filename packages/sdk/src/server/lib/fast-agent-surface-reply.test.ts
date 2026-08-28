const mocks = vi.hoisted(() => ({
  createTeamsProvider: vi.fn(),
  teamsPostMessage: vi.fn(),
  teamsUpdateMessage: vi.fn(),
  createTelegramProvider: vi.fn(),
  telegramPostMessage: vi.fn(),
  telegramEditMessage: vi.fn(),
  findTeamsConversationRoute: vi.fn(),
}));

vi.mock('./teams-communication', () => ({
  createTeamsCommunicationProviderFromRuntimeCredentials:
    mocks.createTeamsProvider,
}));

vi.mock('./telegram-communication', () => ({
  createTelegramCommunicationProviderFromRuntimeCredentials:
    mocks.createTelegramProvider,
}));

vi.mock('../automations/destination', () => ({
  findTeamsConversationRoute: mocks.findTeamsConversationRoute,
}));

import {
  and,
  db,
  eq,
  fastAgentConversations,
  fastAgentProviderMessages,
  fastAgentMessages,
  userFactory,
} from '@roomote/db/server';

import { buildFastAgentSurfaceReplyDelivery } from './fast-agent-surface-reply';

async function createConversation(input: {
  userId: string;
  surface: 'web' | 'automation' | 'slack' | 'teams' | 'telegram';
  replyTarget?: { channelId: string; threadId?: string };
}) {
  const [conversation] = await db
    .insert(fastAgentConversations)
    .values({
      userId: input.userId,
      surface: input.surface,
      workspaceId: `workspace-${input.surface}-${Date.now()}`,
      conversationId: `conversation-${input.surface}-${Date.now()}`,
      currentReplyChannelId: input.replyTarget?.channelId ?? null,
      currentReplyThreadId: input.replyTarget?.threadId ?? null,
    })
    .returning();

  return conversation!;
}

describe('buildFastAgentSurfaceReplyDelivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.teamsPostMessage.mockResolvedValue({
      provider: 'teams',
      channelId: 'teams-channel-1',
      messageId: 'teams-message-1',
    });
    mocks.createTeamsProvider.mockResolvedValue({
      postMessage: mocks.teamsPostMessage,
      updateMessage: mocks.teamsUpdateMessage,
    });
    mocks.telegramPostMessage.mockResolvedValue({
      provider: 'telegram',
      channelId: 'telegram-chat-1',
      messageId: 'telegram-message-1',
      lastTextMessageId: 'telegram-message-2',
    });
    mocks.createTelegramProvider.mockResolvedValue({
      postMessage: mocks.telegramPostMessage,
      editMessageText: mocks.telegramEditMessage,
    });
    mocks.findTeamsConversationRoute.mockResolvedValue({
      serviceUrl: 'https://smba.example.com/amer/',
      workspaceId: 'tenant-1',
    });
  });

  it('serves web sessions with a transcript-only adapter', async () => {
    const user = await userFactory.create();
    const conversation = await createConversation({
      userId: user.id,
      surface: 'web',
    });

    const delivery = await buildFastAgentSurfaceReplyDelivery({
      sessionId: conversation.id,
      userId: user.id,
      senderDisplayName: 'Matt',
      question: 'Follow up',
    });

    expect(delivery).not.toBeNull();
    expect(delivery?.conversation.surface).toBe('web');
    await expect(
      delivery!.adapter.postReply({ purpose: 'closeout', message: 'hi' }),
    ).resolves.toBeUndefined();
  });

  it('serves automation sessions the same transcript-only adapter', async () => {
    const user = await userFactory.create();
    const conversation = await createConversation({
      userId: user.id,
      surface: 'automation',
    });

    const delivery = await buildFastAgentSurfaceReplyDelivery({
      sessionId: conversation.id,
      userId: user.id,
      senderDisplayName: null,
      question: 'Follow up',
    });

    expect(delivery?.conversation.surface).toBe('automation');
  });

  it('allows recorded participants but rejects unrelated users', async () => {
    const owner = await userFactory.create();
    const participant = await userFactory.create();
    const bystander = await userFactory.create();
    const conversation = await createConversation({
      userId: owner.id,
      surface: 'web',
    });
    await db.insert(fastAgentMessages).values({
      conversationId: conversation.id,
      eventId: 'participant-message',
      turnId: 'participant-turn',
      turnSeq: 0,
      ts: Date.now(),
      eventType: 'roomote_runtime.user_prompt',
      role: 'user',
      contentBlocks: [{ type: 'text', text: 'Joined' }],
      metadata: { userId: participant.id, visibleInTranscript: true },
      payload: {},
      source: 'web',
    });

    await expect(
      buildFastAgentSurfaceReplyDelivery({
        sessionId: conversation.id,
        userId: participant.id,
        senderDisplayName: null,
        question: 'Participant follow-up',
      }),
    ).resolves.not.toBeNull();
    await expect(
      buildFastAgentSurfaceReplyDelivery({
        sessionId: conversation.id,
        userId: bystander.id,
        senderDisplayName: null,
        question: 'Bystander follow-up',
      }),
    ).resolves.toBeNull();
  });

  it('returns null for a Slack session without an installation', async () => {
    const user = await userFactory.create();
    const conversation = await createConversation({
      userId: user.id,
      surface: 'slack',
      replyTarget: { channelId: 'C123', threadId: '1700000000.000100' },
    });

    await expect(
      buildFastAgentSurfaceReplyDelivery({
        sessionId: conversation.id,
        userId: user.id,
        senderDisplayName: 'Matt',
        question: 'Follow up',
      }),
    ).resolves.toBeNull();
  });

  it('returns null for an unknown session', async () => {
    const user = await userFactory.create();
    await expect(
      buildFastAgentSurfaceReplyDelivery({
        sessionId: '00000000-0000-4000-8000-000000000000',
        userId: user.id,
        senderDisplayName: null,
        question: 'Follow up',
      }),
    ).resolves.toBeNull();
  });

  it.each([
    {
      surface: 'teams' as const,
      workspaceId: 'tenant-1',
      channelId: 'teams-channel-1',
      threadId: 'teams-root-1',
      currentMessageId: undefined,
      post: mocks.teamsPostMessage,
      replace: mocks.teamsUpdateMessage,
    },
    {
      surface: 'telegram' as const,
      workspaceId: 'telegram-chat-1',
      channelId: 'telegram-chat-1',
      threadId: undefined,
      currentMessageId: 'telegram-inbound-1',
      post: mocks.telegramPostMessage,
      replace: mocks.telegramEditMessage,
    },
  ])(
    'serves $surface sessions with provider-backed reply and replacement adapters',
    async ({
      surface,
      workspaceId,
      channelId,
      threadId,
      currentMessageId,
      post,
      replace,
    }) => {
      const user = await userFactory.create();
      const [conversation] = await db
        .insert(fastAgentConversations)
        .values({
          userId: user.id,
          surface,
          workspaceId,
          conversationId: `${surface}-${Date.now()}`,
          currentReplyChannelId: channelId,
          currentReplyThreadId: threadId ?? null,
        })
        .returning();

      const delivery = await buildFastAgentSurfaceReplyDelivery({
        sessionId: conversation!.id,
        userId: user.id,
        senderDisplayName: 'Matt',
        question: 'Follow up',
        ...(currentMessageId ? { currentMessageId } : {}),
      });
      const handle = await delivery!.adapter.postReply({
        purpose: 'closeout',
        message: 'Done',
      });
      const binding = await db.query.fastAgentProviderMessages.findFirst({
        where: and(
          eq(fastAgentProviderMessages.provider, surface),
          eq(fastAgentProviderMessages.conversationId, conversation!.id),
        ),
      });
      await delivery!.adapter.replaceReply!(handle!, {
        purpose: 'closeout',
        message: 'Updated',
      });

      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId,
          ...(threadId ? { threadId } : {}),
          ...(currentMessageId ? { replyToMessageId: currentMessageId } : {}),
          text: expect.stringContaining('Reply or use the [web app]'),
        }),
      );
      expect(binding?.messageId).toBe(
        surface === 'teams' ? 'teams-message-1' : 'telegram-message-2',
      );
      expect(replace).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId,
          messageId:
            surface === 'teams' ? 'teams-message-1' : 'telegram-message-1',
          text: expect.stringContaining('Updated'),
        }),
      );
    },
  );
});
