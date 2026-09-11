const mocks = vi.hoisted(() => ({
  createTeamsProvider: vi.fn(),
  teamsPostMessage: vi.fn(),
  teamsUpdateMessage: vi.fn(),
  createTelegramProvider: vi.fn(),
  telegramPostMessage: vi.fn(),
  telegramEditMessage: vi.fn(),
  telegramEditForumTopic: vi.fn(),
  telegramResolveForumTopicIcon: vi.fn(),
  telegramTyping: vi.fn(),
  createDiscordProvider: vi.fn(),
  discordTyping: vi.fn(),
  discordPostMessage: vi.fn(),
  discordEditMessage: vi.fn(),
  findTeamsConversationRoute: vi.fn(),
  createActivity: vi.fn(() => ({ start: vi.fn(), settle: vi.fn() })),
  slackPostThreadMessage: vi.fn(),
  deliverVideos: vi.fn(),
  slackUpdateMessage: vi.fn(),
  admitHumanFollowUp: vi.fn(),
  admitInline: vi.fn(),
  acquireTurnLock: vi.fn(),
  answerQuestion: vi.fn(),
  resolveLinearClient: vi.fn(),
  linearEmitResponse: vi.fn(),
  linearGetIssue: vi.fn(),
  buildSourceControlDelivery: vi.fn(),
  sourceControlPostComment: vi.fn(),
  createConversationArtifact: vi.fn(),
}));

vi.mock('./artifacts/create-session-artifact', () => ({
  createFastAgentConversationArtifact: mocks.createConversationArtifact,
}));
vi.mock('./fast-agent-session-videos', () => ({
  deliverFastAgentSessionVideos: mocks.deliverVideos,
}));

vi.mock('@roomote/slack', () => ({
  buildSlackThreadReplyFooterBlock: vi.fn(() => ({ type: 'context' })),
  createFastAgentSlackLiveTaskLauncher: vi.fn(() => vi.fn()),
  createFastAgentSlackSessionActivity: mocks.createActivity,
  getSlackThreadReplyFooterMessageTs: vi.fn(async () => null),
  postSlackThreadMessageWithFooterText: mocks.slackPostThreadMessage,
  withSlackThreadReplyFooterLock: vi.fn(
    async ({
      fn,
    }: {
      fn: (assertLock: () => Promise<void>) => Promise<unknown>;
    }) => fn(async () => {}),
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

vi.mock('./discord-communication', () => ({
  createDiscordCommunicationProviderFromRuntimeCredentials:
    mocks.createDiscordProvider,
}));

vi.mock('../automations/destination', () => ({
  findTeamsConversationRoute: mocks.findTeamsConversationRoute,
}));

vi.mock('./linear-fast-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./linear-fast-session')>();
  return {
    ...actual,
    resolveLinearFastSessionClient: mocks.resolveLinearClient,
  };
});

vi.mock('./source-control-fast-delivery', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./source-control-fast-delivery')>();
  return {
    ...actual,
    buildSourceControlFastDelivery: mocks.buildSourceControlDelivery,
  };
});

vi.mock('@roomote/cloud-agents/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/cloud-agents/server')>()),
  acquireFastAgentTurnLock: mocks.acquireTurnLock,
  answerFastAgentQuestion: mocks.answerQuestion,
}));

vi.mock('./fast-agent-human-follow-up', () => ({
  admitFastAgentHumanFollowUp: mocks.admitHumanFollowUp,
  admitFastAgentInlineHumanTurn: mocks.admitInline,
}));

import {
  FastAgentDurableRetryScheduledError,
  type FastAgentTurnLockHandle,
} from '@roomote/cloud-agents/server';
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
  continueFastAgentSurfaceReplyWithLock,
  queueFastAgentSurfaceReply,
} from './fast-agent-surface-reply';

async function createConversation(input: {
  userId: string;
  surface:
    | 'web'
    | 'automation'
    | 'slack'
    | 'teams'
    | 'telegram'
    | 'discord'
    | 'linear'
    | 'github';
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
    mocks.telegramResolveForumTopicIcon.mockResolvedValue(undefined);
    mocks.teamsPostMessage.mockResolvedValue({
      provider: 'teams',
      channelId: 'teams-channel-1',
      messageId: 'teams-message-1',
    });
    mocks.createTeamsProvider.mockResolvedValue({
      provider: 'teams',
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
      provider: 'telegram',
      postMessage: mocks.telegramPostMessage,
      editMessageText: mocks.telegramEditMessage,
      editForumTopic: mocks.telegramEditForumTopic,
      resolveForumTopicIconCustomEmojiId: mocks.telegramResolveForumTopicIcon,
      sendChatAction: mocks.telegramTyping,
      sendMessageDraft: mocks.telegramTyping,
    });
    mocks.createDiscordProvider.mockResolvedValue({
      triggerTyping: mocks.discordTyping,
      postMessage: mocks.discordPostMessage,
      editMessage: mocks.discordEditMessage,
    });
    mocks.discordPostMessage.mockResolvedValue({
      messageId: 'discord-message-1',
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

  it.each(['discord', 'telegram'] as const)(
    'wires %s typing to the reply target for only the active turn',
    async (surface) => {
      const user = await userFactory.create();
      const replyTarget = { channelId: '123', threadId: '456' };
      const conversation = await createConversation({
        userId: user.id,
        surface,
        replyTarget,
      });
      const delivery = await buildFastAgentSurfaceReplyDelivery({
        sessionId: conversation.id,
        userId: user.id,
        senderDisplayName: null,
        question: 'Hi',
      });
      const typing =
        surface === 'discord' ? mocks.discordTyping : mocks.telegramTyping;
      expect(typing).not.toHaveBeenCalled();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        delivery!.adapter.activity!.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(typing).toHaveBeenCalledWith(
          surface === 'telegram'
            ? expect.objectContaining({
                ...replyTarget,
                draftId: expect.any(Number),
              })
            : replyTarget,
        );
        await vi.advanceTimersByTimeAsync(
          surface === 'discord' ? 8_000 : 25_000,
        );
        expect(typing).toHaveBeenCalledTimes(2);
        await delivery!.adapter.activity!.settle({ keepProcessing: true });
        await vi.advanceTimersByTimeAsync(16_000);
        expect(typing).toHaveBeenCalledTimes(2);
      } finally {
        await delivery!.adapter.activity!.dispose();
        vi.useRealTimers();
      }
    },
  );

  it('streams a private Telegram reply through its native draft before final delivery', async () => {
    const user = await userFactory.create();
    const conversation = await createConversation({
      userId: user.id,
      surface: 'telegram',
      replyTarget: { channelId: '123', threadId: '77' },
    });
    const delivery = await buildFastAgentSurfaceReplyDelivery({
      sessionId: conversation.id,
      userId: user.id,
      senderDisplayName: null,
      question: 'Explain this',
      currentMessageId: '42',
    });
    const adapter = delivery!.adapter;
    expect(adapter.createReplyStream).toBeTypeOf('function');

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      adapter.activity!.start();
      await vi.advanceTimersByTimeAsync(0);
      const stream = adapter.createReplyStream!();
      await stream.append('Partial answer');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mocks.telegramTyping).toHaveBeenLastCalledWith(
        expect.objectContaining({ threadId: '77', text: 'Partial answer' }),
      );
      await expect(
        stream.finish({ purpose: 'closeout', message: 'Final answer' }),
      ).resolves.toEqual({ messageId: 'telegram-message-2' });
      expect(mocks.telegramPostMessage).toHaveBeenCalled();
      await adapter.activity!.settle();
    } finally {
      await adapter.activity!.dispose();
      vi.useRealTimers();
    }
  });

  it('does not offer Telegram draft streaming in groups', async () => {
    const user = await userFactory.create();
    const conversation = await createConversation({
      userId: user.id,
      surface: 'telegram',
      replyTarget: { channelId: '-100123', threadId: '77' },
    });
    const delivery = await buildFastAgentSurfaceReplyDelivery({
      sessionId: conversation.id,
      userId: user.id,
      senderDisplayName: null,
      question: 'Explain this',
    });

    expect(delivery!.adapter.createReplyStream).toBeUndefined();
  });

  it('syncs generated titles to a managed Telegram Fast topic', async () => {
    const user = await userFactory.create();
    const conversation = await createConversation({
      userId: user.id,
      surface: 'telegram',
      title: 'Generated Fast title',
      replyTarget: { channelId: 'telegram-chat', threadId: '77' },
    });
    await db.insert(fastAgentProviderMessages).values({
      conversationId: conversation.id,
      provider: 'telegram',
      workspaceId: conversation.workspaceId,
      channelId: 'telegram-chat',
      threadId: '77',
      messageId: '77',
    });

    const delivery = await buildFastAgentSurfaceReplyDelivery({
      sessionId: conversation.id,
      userId: user.id,
      senderDisplayName: 'Matt',
      question: 'Start here',
      currentMessageId: '78',
    });
    delivery!.adapter.activity?.updateTitle?.('Generated Fast title');
    await delivery!.adapter.activity?.dispose();

    expect(mocks.telegramEditForumTopic).toHaveBeenCalledWith({
      channelId: 'telegram-chat',
      threadId: '77',
      name: 'Generated Fast title',
    });
  });

  it('does not rename a user-owned Telegram topic', async () => {
    const user = await userFactory.create();
    const conversation = await createConversation({
      userId: user.id,
      surface: 'telegram',
      title: 'Generated Fast title',
      replyTarget: { channelId: 'telegram-chat', threadId: '77' },
    });

    const delivery = await buildFastAgentSurfaceReplyDelivery({
      sessionId: conversation.id,
      userId: user.id,
      senderDisplayName: 'Matt',
      question: 'Continue here',
      currentMessageId: '78',
    });
    delivery!.adapter.activity?.updateTitle?.('Generated Fast title');
    await delivery!.adapter.activity?.dispose();

    expect(mocks.telegramEditForumTopic).not.toHaveBeenCalled();
  });

  it.each(['discord', 'telegram'] as const)(
    'reasserts %s after successful posts and replacements but not after a late post',
    async (surface) => {
      const typing =
        surface === 'discord' ? mocks.discordTyping : mocks.telegramTyping;
      const postMessage =
        surface === 'discord'
          ? mocks.discordPostMessage
          : mocks.telegramPostMessage;
      const editMessage =
        surface === 'discord'
          ? mocks.discordEditMessage
          : mocks.telegramEditMessage;
      const user = await userFactory.create();
      const conversation = await createConversation({
        userId: user.id,
        surface,
        replyTarget: { channelId: '123' },
      });
      const delivery = await buildFastAgentSurfaceReplyDelivery({
        sessionId: conversation.id,
        userId: user.id,
        senderDisplayName: null,
        question: 'Hi',
      });
      const adapter = delivery!.adapter;
      const reply = { purpose: 'closeout' as const, message: 'Working' };
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        adapter.activity!.start();
        await vi.advanceTimersByTimeAsync(0);
        await adapter.postReply(reply);
        await vi.advanceTimersByTimeAsync(surface === 'telegram' ? 500 : 0);
        expect(typing).toHaveBeenCalledTimes(2);
        await adapter.replaceReply!({ messageId: '123' }, reply);
        await vi.advanceTimersByTimeAsync(surface === 'telegram' ? 500 : 0);
        expect(typing).toHaveBeenCalledTimes(3);
        editMessage.mockRejectedValueOnce(new Error('edit failed'));
        await expect(
          adapter.replaceReply!({ messageId: '123' }, reply),
        ).rejects.toThrow('edit failed');
        expect(typing).toHaveBeenCalledTimes(3);
        postMessage.mockRejectedValueOnce(new Error('post failed'));
        await expect(adapter.postReply(reply)).rejects.toThrow('post failed');
        expect(typing).toHaveBeenCalledTimes(3);
        let resolveLate!: (value: { messageId: string }) => void;
        const late = new Promise<{ messageId: string }>((resolve) => {
          resolveLate = resolve;
        });
        postMessage.mockReturnValueOnce(late);
        const posting = adapter.postReply(reply);
        await adapter.activity!.dispose();
        resolveLate({ messageId: '789' });
        await posting;
        await vi.advanceTimersByTimeAsync(8_000);
        expect(typing).toHaveBeenCalledTimes(3);
      } finally {
        await adapter.activity!.dispose();
        vi.useRealTimers();
      }
    },
  );

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

  it('lets web follow-up turns create artifacts in the Session', async () => {
    const user = await userFactory.create();
    const conversation = await createConversation({
      userId: user.id,
      surface: 'web',
    });
    mocks.createConversationArtifact.mockResolvedValue({ id: 'artifact-1' });

    const delivery = await buildFastAgentSurfaceReplyDelivery({
      sessionId: conversation.id,
      userId: user.id,
      senderDisplayName: 'Matt',
      question: 'Write this up as a plan',
    });

    await expect(
      delivery!.adapter.createArtifact!({
        path: 'plans/flying-animals.md',
        content: '# Plan',
        contentType: 'text/markdown',
        artifactType: 'plan',
      }),
    ).resolves.toEqual({ id: 'artifact-1' });
    expect(mocks.createConversationArtifact).toHaveBeenCalledWith({
      fastConversationId: conversation.id,
      path: 'plans/flying-animals.md',
      content: '# Plan',
      contentType: 'text/markdown',
      artifactType: 'plan',
    });
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

  it('posts Linear replies as agent-session responses and launches session-bound tasks', async () => {
    mocks.resolveLinearClient.mockResolvedValue({
      emitResponse: mocks.linearEmitResponse,
      getAgentSessionIssue: mocks.linearGetIssue,
    });
    mocks.linearEmitResponse.mockResolvedValue({ success: true });
    const user = await userFactory.create();
    const conversation = await createConversation({
      userId: user.id,
      surface: 'linear',
      replyTarget: { channelId: 'agent-session-1' },
    });

    const delivery = await buildFastAgentSurfaceReplyDelivery({
      sessionId: conversation.id,
      userId: user.id,
      senderDisplayName: 'Dana',
      question: 'Fix the retry loop',
      currentMessageId: 'activity-1',
    });

    expect(delivery?.conversation).toMatchObject({
      surface: 'linear',
      replyTarget: { channelId: 'agent-session-1' },
    });
    expect(mocks.resolveLinearClient).toHaveBeenCalledWith(
      conversation.workspaceId,
    );
    const handle = await delivery!.adapter.postReply({
      message: 'On it.',
    } as never);
    expect(mocks.linearEmitResponse).toHaveBeenCalledWith(
      'agent-session-1',
      'On it.',
    );
    expect(handle).toMatchObject({
      messageId: expect.stringMatching(/^linear-response:/),
    });
    expect(delivery?.adapter.launchTask).toEqual(expect.any(Function));
  });

  it('posts GitHub replies as discussion comments and launches PR-bound tasks', async () => {
    mocks.buildSourceControlDelivery.mockResolvedValue({
      postComment: mocks.sourceControlPostComment,
      resolveTarget: async () => ({}),
    });
    mocks.sourceControlPostComment.mockResolvedValue({ messageId: '5001' });
    const user = await userFactory.create();
    const [row] = await db
      .insert(fastAgentConversations)
      .values({
        userId: user.id,
        surface: 'github',
        workspaceId: `github.com/acme/api-${Date.now()}`,
        conversationId: 'pull/42',
        currentReplyChannelId: 'pull/42',
        currentReplyThreadId: null,
      })
      .returning();

    const delivery = await buildFastAgentSurfaceReplyDelivery({
      sessionId: row!.id,
      userId: user.id,
      senderDisplayName: 'alice',
      question: 'Address the review',
      currentMessageId: 'github:comment:777',
    });

    expect(delivery?.conversation).toMatchObject({
      surface: 'github',
      conversationId: 'pull/42',
    });
    const handle = await delivery!.adapter.postReply({
      message: 'On it.',
    } as never);
    expect(handle).toEqual({ messageId: '5001' });
    expect(mocks.sourceControlPostComment).toHaveBeenCalledWith(
      expect.objectContaining({
        discussion: expect.objectContaining({ kind: 'pull', number: 42 }),
        body: expect.stringContaining('On it.'),
      }),
    );
    expect(delivery?.adapter.launchTask).toEqual(expect.any(Function));
  });

  it('returns null for a Linear session whose organization is not connected', async () => {
    mocks.resolveLinearClient.mockResolvedValue(null);
    const user = await userFactory.create();
    const conversation = await createConversation({
      userId: user.id,
      surface: 'linear',
      replyTarget: { channelId: 'agent-session-1' },
    });

    await expect(
      buildFastAgentSurfaceReplyDelivery({
        sessionId: conversation.id,
        userId: user.id,
        senderDisplayName: null,
        question: 'Hello',
        currentMessageId: 'activity-1',
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

  it.each(['', '[View video](https://roomote.example/video)'])(
    'binds Slack surface replies and selected videos to the Fast session with fallback %j',
    async (fallback) => {
      mocks.deliverVideos.mockResolvedValueOnce(fallback);
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
        videoArtifactIds: ['video-1'],
      });
      expect(mocks.deliverVideos).toHaveBeenCalledExactlyOnceWith({
        artifactIds: ['video-1'],
        sessionId: conversation.id,
        channelId: 'C456',
        threadTs: '1700000000.000200',
      });
      expect(mocks.slackPostThreadMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          bodyBlocks: expect.arrayContaining([
            {
              type: 'markdown',
              text: ['First reply', fallback].filter(Boolean).join('\n\n'),
            },
          ]),
        }),
      );
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
    },
  );

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
          text: expect.stringContaining('[Open in Roomote]'),
        }),
      );
      expect(binding?.messageId).toBe(
        surface === 'teams' ? 'teams-message-1' : 'telegram-message-2',
      );
      expect(replace).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId,
          messageId:
            surface === 'teams' ? 'teams-message-1' : 'telegram-message-2',
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

  it('admits a reaction turn durably with its input and resumes a still-pending row', async () => {
    const user = await userFactory.create();
    const conversation = await createConversation({
      userId: user.id,
      surface: 'web',
    });
    const release = Object.assign(vi.fn().mockResolvedValue(undefined), {
      signal: new AbortController().signal,
      abort: vi.fn().mockResolvedValue(undefined),
    });
    // Admission took the idle conversation's lock and found the row still
    // pending from an earlier attempt (a redelivered event), so this run is
    // a resumption.
    mocks.admitHumanFollowUp.mockResolvedValue({
      kind: 'turn',
      turnLock: release,
      durable: { id: 'row-1', eventKey: 'key-1', resumed: true },
    });
    mocks.answerQuestion.mockResolvedValue('');
    const externalInput = {
      type: 'reaction_added' as const,
      provider: 'slack' as const,
      reactions: [{ name: 'eyes' }],
      reactor: { externalUserId: 'U1' },
      message: {
        workspaceId: 'T1',
        channelId: 'C1',
        messageId: '100.001',
        threadId: '100.000',
      },
      eventId: '102.000',
    };

    await expect(
      continueFastAgentSurfaceReply({
        sessionId: conversation.id,
        userId: user.id,
        senderDisplayName: 'Matt',
        question: '<external_input>{}</external_input>',
        currentMessageId: 'slack-reaction:102.000',
        externalInput,
      }),
    ).resolves.toBe(true);

    // The reaction is admitted before anything runs, with the reaction
    // recorded on the row so the queue can resume it as a reaction turn; the
    // admitted lock and row are reused rather than acquired again.
    expect(mocks.admitHumanFollowUp).toHaveBeenCalledWith({
      parent: expect.objectContaining({ sessionId: conversation.id }),
      event: expect.objectContaining({
        type: 'human_follow_up',
        currentMessageId: 'slack-reaction:102.000',
        senderExternalId: 'U1',
        input: { type: 'reaction', externalInput },
      }),
      forceQueue: false,
    });
    expect(mocks.acquireTurnLock).not.toHaveBeenCalled();
    expect(mocks.admitInline).not.toHaveBeenCalled();
    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { type: 'reaction', externalInput },
        durableAdmission: { eventId: 'row-1' },
        resumedAfterInterruption: true,
      }),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it('admits a queued reaction webhook durably before acknowledging it, steering it when a turn is active', async () => {
    const user = await userFactory.create();
    const conversation = await createConversation({
      userId: user.id,
      surface: 'web',
    });
    const abort = vi.fn();
    mocks.admitHumanFollowUp.mockResolvedValue({ kind: 'steered', abort });
    const externalInput = {
      type: 'reaction_added' as const,
      provider: 'teams' as const,
      reactions: [{ name: 'like' }],
      reactor: { externalUserId: 'teams-user-1' },
      message: {
        workspaceId: 'tenant-1',
        channelId: 'conversation-1',
        messageId: 'message-7',
      },
      eventId: 'reaction-7',
    };

    await expect(
      queueFastAgentSurfaceReply({
        sessionId: conversation.id,
        userId: user.id,
        senderDisplayName: 'Matt',
        question: '<external_input>{}</external_input>',
        currentMessageId: 'teams-reaction:reaction-7',
        externalInput,
      }),
    ).resolves.toBe(true);

    // The row exists before the webhook returns, so a restart in the gap
    // cannot lose the reaction. Reactions are never force-queued: their
    // reply targets the reacted-to message, which only inline delivery does.
    expect(mocks.admitHumanFollowUp).toHaveBeenCalledWith({
      parent: expect.objectContaining({ sessionId: conversation.id }),
      event: expect.objectContaining({
        currentMessageId: 'teams-reaction:reaction-7',
        input: { type: 'reaction', externalInput },
      }),
      forceQueue: false,
    });
    expect(mocks.answerQuestion).not.toHaveBeenCalled();
    expect(mocks.acquireTurnLock).not.toHaveBeenCalled();
  });

  it('skips a message whose durable row already settled instead of re-running it', async () => {
    const user = await userFactory.create();
    const conversation = await createConversation({
      userId: user.id,
      surface: 'web',
    });
    const release = Object.assign(vi.fn().mockResolvedValue(undefined), {
      signal: new AbortController().signal,
      abort: vi.fn().mockResolvedValue(undefined),
    });
    // The queue resumed and delivered this message after an interruption;
    // a redelivery must not run it a second time.
    mocks.admitHumanFollowUp.mockResolvedValue({
      kind: 'turn',
      turnLock: release,
      durable: null,
      settled: true,
    });

    await expect(
      continueFastAgentSurfaceReply({
        sessionId: conversation.id,
        userId: user.id,
        senderDisplayName: 'Matt',
        question: 'Follow up',
        currentMessageId: 'web-message-1',
      }),
    ).resolves.toBe(true);

    expect(mocks.answerQuestion).not.toHaveBeenCalled();
    expect(mocks.admitInline).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
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

describe('continueFastAgentSurfaceReplyWithLock outcomes', () => {
  function callerLock(): FastAgentTurnLockHandle {
    return Object.assign(vi.fn().mockResolvedValue(undefined), {
      signal: new AbortController().signal,
      abort: vi.fn().mockResolvedValue(undefined),
    }) as unknown as FastAgentTurnLockHandle;
  }

  it('reports an unroutable session without running anything', async () => {
    const user = await userFactory.create();

    await expect(
      continueFastAgentSurfaceReplyWithLock(
        {
          sessionId: '00000000-0000-4000-8000-000000000000',
          userId: user.id,
          senderDisplayName: null,
          question: 'Follow up',
          currentMessageId: 'message-1',
        },
        callerLock(),
      ),
    ).resolves.toEqual({ outcome: 'unroutable' });
    expect(mocks.answerQuestion).not.toHaveBeenCalled();
  });

  it('skips a settled message under the caller-owned lock', async () => {
    const user = await userFactory.create();
    const conversation = await createConversation({
      userId: user.id,
      surface: 'web',
    });
    mocks.admitInline.mockResolvedValue({ status: 'settled' });
    const lock = callerLock();

    await expect(
      continueFastAgentSurfaceReplyWithLock(
        {
          sessionId: conversation.id,
          userId: user.id,
          senderDisplayName: 'Matt',
          question: 'Follow up',
          currentMessageId: 'web-message-1',
        },
        lock,
      ),
    ).resolves.toEqual({ outcome: 'settled' });
    expect(mocks.answerQuestion).not.toHaveBeenCalled();
    expect(lock.durableRowId).toBeUndefined();
  });

  it('surfaces a parked turn with its retry time and unbinds the row from the lock', async () => {
    const user = await userFactory.create();
    const conversation = await createConversation({
      userId: user.id,
      surface: 'web',
    });
    mocks.admitInline.mockResolvedValue({
      status: 'admitted',
      turn: { id: 'row-1', eventKey: 'key-1' },
    });
    const retryAt = new Date(Date.now() + 60_000);
    mocks.answerQuestion.mockRejectedValue(
      new FastAgentDurableRetryScheduledError(retryAt),
    );
    const lock = callerLock();

    await expect(
      continueFastAgentSurfaceReplyWithLock(
        {
          sessionId: conversation.id,
          userId: user.id,
          senderDisplayName: 'Matt',
          question: 'Follow up',
          currentMessageId: 'web-message-1',
        },
        lock,
      ),
    ).resolves.toEqual({ outcome: 'parked', retryAt });
    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ durableAdmission: { eventId: 'row-1' } }),
    );
    expect(lock.durableRowId).toBeUndefined();
    expect(lock.durableResume).toBeUndefined();
  });

  it('reports delivery for a completed turn', async () => {
    const user = await userFactory.create();
    const conversation = await createConversation({
      userId: user.id,
      surface: 'web',
    });
    mocks.admitInline.mockResolvedValue({
      status: 'admitted',
      turn: { id: 'row-1', eventKey: 'key-1' },
    });
    mocks.answerQuestion.mockResolvedValue('');

    await expect(
      continueFastAgentSurfaceReplyWithLock(
        {
          sessionId: conversation.id,
          userId: user.id,
          senderDisplayName: 'Matt',
          question: 'Follow up',
          currentMessageId: 'web-message-1',
        },
        callerLock(),
      ),
    ).resolves.toEqual({ outcome: 'delivered' });
  });
});
