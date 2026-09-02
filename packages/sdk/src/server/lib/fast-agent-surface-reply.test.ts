const mocks = vi.hoisted(() => ({
  createTeamsProvider: vi.fn(),
  teamsPostMessage: vi.fn(),
  teamsUpdateMessage: vi.fn(),
  createTelegramProvider: vi.fn(),
  telegramPostMessage: vi.fn(),
  telegramEditMessage: vi.fn(),
  findTeamsConversationRoute: vi.fn(),
  createActivity: vi.fn(() => ({ start: vi.fn(), settle: vi.fn() })),
  slackPostThreadMessage: vi.fn(),
  slackUpdateMessage: vi.fn(),
  admitHumanFollowUp: vi.fn(),
}));

vi.mock('@roomote/slack', () => ({
  buildSlackThreadReplyFooterBlock: vi.fn(() => ({ type: 'context' })),
  createFastAgentSlackLiveTaskLauncher: vi.fn(() => vi.fn()),
  createFastAgentSlackSessionActivity: mocks.createActivity,
  getSlackThreadReplyFooterMessageTs: vi.fn(async () => null),
  postSlackThreadMessageWithFooterText: mocks.slackPostThreadMessage,
  withSlackThreadReplyFooterLock: vi.fn(
    async ({ fn }: { fn: () => Promise<unknown> }) => fn(),
  ),
  ROOMOTE_THREAD_REPLY_QUOTE_BLOCK_ID: 'quote',
  SlackNotifier: vi.fn(function () {
    return { updateMessage: mocks.slackUpdateMessage };
  }),
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

vi.mock('./fast-agent-human-follow-up', () => ({
  admitFastAgentHumanFollowUp: mocks.admitHumanFollowUp,
}));

import {
  and,
  db,
  eq,
  fastAgentConversations,
  fastAgentProviderMessages,
  fastAgentMessages,
  slackInstallations,
  userFactory,
} from '@roomote/db/server';

import {
  buildFastAgentSurfaceReplyDelivery,
  continueFastAgentSurfaceReply,
  queueFastAgentSurfaceReply,
} from './fast-agent-surface-reply';

async function createConversation(input: {
  userId: string;
  surface: 'web' | 'automation' | 'slack' | 'teams' | 'telegram';
  title?: string;
  replyTarget?: { channelId: string; threadId?: string };
}) {
  const [conversation] = await db
    .insert(fastAgentConversations)
    .values({
      userId: input.userId,
      surface: input.surface,
      workspaceId: `workspace-${input.surface}-${Date.now()}`,
      conversationId: `conversation-${input.surface}-${Date.now()}`,
      title: input.title ?? null,
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
    mocks.slackPostThreadMessage.mockResolvedValue('slack-message-1');
    mocks.slackUpdateMessage.mockResolvedValue(true);
    mocks.admitHumanFollowUp.mockResolvedValue({
      kind: 'queued',
      abort: vi.fn(),
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

  it('reports durable admission failures instead of acknowledging the queued follow-up', async () => {
    const user = await userFactory.create();
    const conversation = await createConversation({
      userId: user.id,
      surface: 'web',
    });
    mocks.admitHumanFollowUp.mockRejectedValueOnce(
      new Error('database unavailable'),
    );

    await expect(
      queueFastAgentSurfaceReply({
        sessionId: conversation.id,
        userId: user.id,
        senderDisplayName: 'Matt',
        question: 'Follow up',
        currentMessageId: 'web-message-1',
      }),
    ).rejects.toThrow('database unavailable');
    expect(mocks.admitHumanFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({ forceQueue: true }),
    );
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

  it('allows every deployment user to reply, like tasks', async () => {
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
    ).resolves.not.toBeNull();
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

  it('binds Slack surface replies and replacements to the Fast session', async () => {
    const user = await userFactory.create();
    const conversation = await createConversation({
      userId: user.id,
      surface: 'slack',
      title: 'Investigate Slack agent status',
      replyTarget: { channelId: 'C456', threadId: '1700000000.000200' },
    });
    await db.insert(slackInstallations).values({
      teamId: conversation.workspaceId,
      teamName: 'Test workspace',
      appId: 'A123',
      botUserId: 'B123',
      botAccessToken: 'xoxb-test',
      scopes: { bot: ['chat:write'] },
      installedByUserId: user.id,
      isActive: true,
    });

    const delivery = await buildFastAgentSurfaceReplyDelivery({
      sessionId: conversation.id,
      userId: user.id,
      senderDisplayName: 'Matt',
      question: 'Follow up',
    });
    const handle = await delivery!.adapter.postReply({
      purpose: 'closeout',
      message: 'First reply',
    });
    await delivery!.adapter.replaceReply!(handle!, {
      purpose: 'closeout',
      message: 'Updated reply',
    });

    expect(mocks.createActivity).toHaveBeenCalledWith({
      slack: expect.anything(),
      workspaceId: conversation.workspaceId,
      channel: 'C456',
      threadTs: '1700000000.000200',
      title: 'Investigate Slack agent status',
      resolveTitle: expect.any(Function),
    });

    await expect(
      db.query.fastAgentProviderMessages.findFirst({
        where: and(
          eq(fastAgentProviderMessages.provider, 'slack'),
          eq(fastAgentProviderMessages.conversationId, conversation.id),
          eq(fastAgentProviderMessages.messageId, 'slack-message-1'),
        ),
      }),
    ).resolves.toMatchObject({
      workspaceId: conversation.workspaceId,
      channelId: 'C456',
      threadId: '1700000000.000200',
    });
    expect(mocks.slackUpdateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ ts: 'slack-message-1' }),
    );
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

  it('keeps a Telegram reaction event id separate from its reply target', async () => {
    const user = await userFactory.create();
    const [conversation] = await db
      .insert(fastAgentConversations)
      .values({
        userId: user.id,
        surface: 'telegram',
        workspaceId: 'telegram-chat-reaction',
        conversationId: `telegram-reaction-${Date.now()}`,
        currentReplyChannelId: 'telegram-chat-reaction',
      })
      .returning();

    const delivery = await buildFastAgentSurfaceReplyDelivery({
      sessionId: conversation!.id,
      userId: user.id,
      senderDisplayName: 'Matt',
      question: '<external_input>{}</external_input>',
      currentMessageId: 'telegram-reaction:123',
      replyToMessageId: '777',
      externalInput: {
        type: 'reaction_added',
        provider: 'telegram',
        reactions: [{ name: '👍' }],
        reactor: { externalUserId: '111', displayName: 'Matt' },
        message: {
          workspaceId: 'telegram-chat-reaction',
          channelId: 'telegram-chat-reaction',
          messageId: '777',
        },
        eventId: '123',
      },
    });

    await delivery!.adapter.postReply({
      purpose: 'closeout',
      message: 'Thanks for confirming.',
    });

    expect(mocks.telegramPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        replyToMessageId: '777',
        text: expect.not.stringContaining('external_input'),
      }),
    );
  });
});

describe('continueFastAgentSurfaceReply admission hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports admission with the queued follow-up’s abort before the turn runs', async () => {
    const user = await userFactory.create();
    const conversation = await createConversation({
      userId: user.id,
      surface: 'web',
    });
    const abort = vi.fn();
    mocks.admitHumanFollowUp.mockResolvedValue({ kind: 'queued', abort });
    const onAccepted = vi.fn();
    const onRejected = vi.fn();

    await expect(
      continueFastAgentSurfaceReply({
        sessionId: conversation.id,
        userId: user.id,
        senderDisplayName: 'Matt',
        question: 'Follow up',
        currentMessageId: 'message-1',
        onAccepted,
        onRejected,
      }),
    ).resolves.toBe(true);

    expect(onAccepted).toHaveBeenCalledWith(abort);
    expect(onRejected).not.toHaveBeenCalled();
  });

  it('reports rejection when the session has no delivery route', async () => {
    const user = await userFactory.create();
    const onAccepted = vi.fn();
    const onRejected = vi.fn();

    await expect(
      continueFastAgentSurfaceReply({
        sessionId: '00000000-0000-4000-8000-000000000000',
        userId: user.id,
        senderDisplayName: null,
        question: 'Follow up',
        currentMessageId: 'message-1',
        onAccepted,
        onRejected,
      }),
    ).resolves.toBe(false);

    expect(onRejected).toHaveBeenCalledTimes(1);
    expect(onAccepted).not.toHaveBeenCalled();
    expect(mocks.admitHumanFollowUp).not.toHaveBeenCalled();
  });
});
