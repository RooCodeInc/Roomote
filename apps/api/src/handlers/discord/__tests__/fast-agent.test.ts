const mocks = vi.hoisted(() => ({
  acquireLock: vi.fn(),
  answerQuestion: vi.fn(),
  fetchHistory: vi.fn(),
  getMessage: vi.fn(),
  releaseLock: vi.fn(),
  reply: vi.fn(),
  resolveWorkspace: vi.fn(),
  startTask: vi.fn(),
  recordProviderMessage: vi.fn(),
  admitHumanFollowUp: vi.fn(),
}));

vi.mock('@roomote/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/redis')>();
  return {
    ...actual,
    // The sticky-footer lock and state live in Redis; unit tests run without
    // a server, so satisfy lock acquisition and empty prior state.
    getRedis: () => ({
      set: async () => 'OK',
      get: async () => null,
      eval: async () => 1,
    }),
  };
});

vi.mock('@roomote/cloud-agents/server', () => ({
  acquireFastAgentTurnLock: mocks.acquireLock,
  answerFastAgentQuestion: mocks.answerQuestion,
  resolveApiBaseUrl: () => 'https://roomote.example.com',
  getOrCreateFastAgentSession: vi
    .fn()
    .mockResolvedValue({ id: 'fast-session-1' }),
}));

vi.mock('@roomote/sdk/server', () => ({
  admitFastAgentHumanFollowUp: mocks.admitHumanFollowUp,
  recordFastAgentConversationMessageBestEffort: mocks.recordProviderMessage,
  resolveUserMcpServerConfigs: vi.fn(async () => ({})),
}));

vi.mock('@roomote/communication/discord-event', () => ({
  getDiscordMessageCreate: mocks.getMessage,
}));

vi.mock('@roomote/communication', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/communication')>()),
  resolveFastSessionReplyFooterContext: vi.fn(async () => ({
    linkedPrs: [],
    livePreviewUrl: null,
  })),
}));

vi.mock('@roomote/env', () => ({
  Env: { R_APP_URL: 'https://roomote.example.com' },
}));

vi.mock('../replies.js', () => ({
  replyToDiscordEvent: mocks.reply,
}));

vi.mock('../thread-context.js', () => ({
  fetchDiscordThreadHistoryBestEffort: mocks.fetchHistory,
}));

vi.mock('../task-launch.js', () => ({
  discordMetadataForChannel: vi.fn(),
  resolveDiscordWorkspace: mocks.resolveWorkspace,
}));

vi.mock('../task-orchestration.js', () => ({
  startNewDiscordTask: mocks.startTask,
}));

import { ALL_REPOSITORIES } from '@roomote/types';

import {
  getDiscordFastLaunchSourceEventId,
  processDiscordFastAgentMessage,
} from '../fast-agent.js';

describe('getDiscordFastLaunchSourceEventId', () => {
  it('is stable for launch retries and distinct for independent launches', () => {
    const checkout = {
      eventId: 'event-1',
      prompt: 'Fix checkout',
      environmentId: 'env-1',
      model: null,
    };

    expect(getDiscordFastLaunchSourceEventId(checkout)).toBe(
      getDiscordFastLaunchSourceEventId(checkout),
    );
    expect(getDiscordFastLaunchSourceEventId(checkout)).not.toBe(
      getDiscordFastLaunchSourceEventId({
        ...checkout,
        prompt: 'Update checkout docs',
      }),
    );
  });
});

describe('processDiscordFastAgentMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acquireLock.mockResolvedValue(mocks.releaseLock);
    mocks.admitHumanFollowUp.mockResolvedValue({
      kind: 'turn',
      turnLock: mocks.releaseLock,
    });
    mocks.releaseLock.mockResolvedValue(undefined);
    mocks.fetchHistory.mockResolvedValue([]);
    mocks.getMessage.mockReturnValue({ id: 'source-1' });
    mocks.reply.mockResolvedValue({
      provider: 'discord',
      channelId: 'channel-1',
      messageId: 'retry-1',
      lastTextMessageId: 'retry-1',
    });
    mocks.startTask.mockResolvedValue({
      status: 'started',
      launchResult: { taskId: 'task-1' },
      taskUrl: 'https://roomote.example.com/task/task-1',
    });
  });

  it('durably queues a follow-up instead of waiting on an active turn lock', async () => {
    const abort = vi.fn().mockResolvedValue(undefined);
    const onAccepted = vi.fn();
    mocks.acquireLock.mockResolvedValue(null);
    mocks.admitHumanFollowUp.mockResolvedValue({ kind: 'queued', abort });

    await expect(
      processDiscordFastAgentMessage({
        eventId: 'event-2',
        question: 'Use the corrected requirement',
        sender: { id: 'discord-user-1', username: 'Matt' },
        senderUserId: 'user-1',
        provider: {} as never,
        applicationId: 'app-1',
        channel: {
          channelId: 'dm-1',
          channelType: 1,
          isDirectMessage: true,
          isThread: false,
        } as never,
        metadata: { communicationChannelId: 'dm-1' } as never,
        conversationId: 'dm-1',
        onAccepted,
      }),
    ).resolves.toBe(true);

    expect(mocks.admitHumanFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'human_follow_up',
          eventId: 'event-2',
          question: 'Use the corrected requirement',
        }),
      }),
    );
    expect(onAccepted).toHaveBeenCalledWith(abort);
    expect(mocks.answerQuestion).not.toHaveBeenCalled();
  });

  it('replaces a Fast retry notice in place', async () => {
    const provider = {
      editMessage: vi.fn().mockResolvedValue(undefined),
    };
    mocks.answerQuestion.mockImplementationOnce(
      async ({
        adapter,
      }: {
        adapter: {
          postReply: (reply: unknown) => Promise<{ messageId: string }>;
          replaceReply: (
            handle: { messageId: string },
            reply: unknown,
          ) => Promise<{ messageId: string }>;
        };
      }) => {
        const handle = await adapter.postReply({
          purpose: 'progress',
          message: 'Retrying connection to the inference provider.',
        });
        await adapter.replaceReply(handle, {
          purpose: 'closeout',
          message: 'Connection restored.',
        });
        return 'Connection restored.';
      },
    );

    await processDiscordFastAgentMessage({
      event: { eventId: 'event-1' } as never,
      question: 'Investigate this',
      sender: { id: 'discord-user-1', username: 'matt' } as never,
      senderUserId: 'user-1',
      provider: provider as never,
      applicationId: 'application-1',
      channel: {
        channelId: 'channel-1',
        guildId: null,
        isDirectMessage: true,
        isThread: false,
      } as never,
      metadata: {
        communicationChannelId: 'channel-1',
      } as never,
      conversationId: 'channel-1',
    });

    expect(mocks.reply).toHaveBeenCalledOnce();
    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ currentMessageId: 'source-1' }),
    );
    expect(provider.editMessage).toHaveBeenCalledWith({
      channelId: 'channel-1',
      messageId: 'retry-1',
      text: 'Connection restored.',
    });
    expect(mocks.releaseLock).toHaveBeenCalledOnce();
  });

  it('allows silence only for an undirected turn with another human participant', async () => {
    mocks.fetchHistory.mockResolvedValue([
      { id: '100', user: 'discord-user-2', text: 'Hi', attachments: [] },
      {
        id: '101',
        user: 'application-1',
        botId: 'application-1',
        text: 'Hello',
        attachments: [],
      },
    ]);
    const provider = { editMessage: vi.fn().mockResolvedValue(undefined) };

    await processDiscordFastAgentMessage({
      event: { eventId: 'event-1' } as never,
      question: 'Makes sense',
      sender: { id: 'discord-user-1', username: 'matt' } as never,
      senderUserId: 'user-1',
      provider: provider as never,
      applicationId: 'application-1',
      channel: {
        channelId: 'channel-1',
        guildId: 'guild-1',
        isDirectMessage: false,
        isThread: true,
      } as never,
      metadata: {
        communicationChannelId: 'parent-1',
        communicationThreadId: 'channel-1',
      } as never,
      conversationId: 'channel-1',
    });

    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ allowSilentAmbientReply: true }),
    );
  });

  it('requires a response for a directed turn with another human participant', async () => {
    mocks.fetchHistory.mockResolvedValue([
      { id: '100', user: 'discord-user-2', text: 'Hi', attachments: [] },
    ]);
    const provider = { editMessage: vi.fn().mockResolvedValue(undefined) };

    await processDiscordFastAgentMessage({
      event: { eventId: 'event-1' } as never,
      question: 'Can you expand on that?',
      sender: { id: 'discord-user-1', username: 'matt' } as never,
      senderUserId: 'user-1',
      provider: provider as never,
      applicationId: 'application-1',
      channel: {
        channelId: 'channel-1',
        guildId: 'guild-1',
        isDirectMessage: false,
        isThread: true,
      } as never,
      metadata: {
        communicationChannelId: 'parent-1',
        communicationThreadId: 'channel-1',
      } as never,
      conversationId: 'channel-1',
      directedAtRoomote: true,
    });

    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ allowSilentAmbientReply: false }),
    );
  });

  it.each([
    { channelType: 0, threadType: 11, label: 'text' },
    { channelType: 5, threadType: 10, label: 'announcement' },
  ])(
    'creates an anchored thread for a new guild $label-channel Fast conversation',
    async ({ channelType, threadType }) => {
      const provider = {
        createThreadFromMessage: vi.fn().mockResolvedValue({
          channelId: 'source-1',
          parentChannelId: 'channel-1',
          name: 'Investigate this',
          kind: 'thread',
          messageId: 'source-1',
        }),
        editMessage: vi.fn().mockResolvedValue(undefined),
      };
      mocks.answerQuestion.mockImplementationOnce(
        async ({
          adapter,
        }: {
          adapter: {
            launchTask: (input: {
              prompt: string;
              environmentId: string;
              parentSessionId: string;
              postKickoff: () => Promise<void>;
            }) => Promise<unknown>;
          };
        }) => {
          await adapter.launchTask({
            prompt: 'Fix the flaky tests',
            environmentId: ALL_REPOSITORIES,
            parentSessionId: 'session-1',
            postKickoff: vi.fn().mockResolvedValue(undefined),
          });
          return 'A quick answer';
        },
      );

      await processDiscordFastAgentMessage({
        event: { eventId: 'source-1' } as never,
        question: 'Investigate this',
        sender: { id: 'discord-user-1', username: 'matt' } as never,
        senderUserId: 'user-1',
        provider: provider as never,
        applicationId: 'application-1',
        channel: {
          channelId: 'channel-1',
          channelName: 'general',
          channelType,
          guildId: 'guild-1',
          isDirectMessage: false,
          isThread: false,
        },
        metadata: {
          communicationChannelId: 'channel-1',
          communicationMessageId: 'source-1',
          communicationAnchorMessageId: 'source-1',
          communicationGuildId: 'guild-1',
        } as never,
        conversationId: 'source-1',
      });

      expect(provider.createThreadFromMessage).toHaveBeenCalledWith({
        channelId: 'channel-1',
        messageId: 'source-1',
        name: 'Investigate this',
      });
      expect(mocks.answerQuestion).toHaveBeenCalledWith(
        expect.objectContaining({
          conversation: {
            surface: 'discord',
            workspaceId: 'guild-1',
            conversationId: 'source-1',
            replyTarget: { channelId: 'channel-1', threadId: 'source-1' },
          },
        }),
      );
      expect(mocks.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: expect.objectContaining({
            channelId: 'source-1',
            parentChannelId: 'channel-1',
            channelType: threadType,
            isThread: true,
          }),
          replyToMessageId: 'source-1',
        }),
      );
      expect(mocks.startTask).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: expect.objectContaining({
            channelId: 'source-1',
            parentChannelId: 'channel-1',
            isThread: true,
          }),
          metadata: expect.objectContaining({
            communicationChannelId: 'channel-1',
            communicationThreadId: 'source-1',
          }),
        }),
      );
      expect(mocks.startTask.mock.calls[0]?.[0]).not.toHaveProperty(
        'forceNewThread',
      );
    },
  );

  it('anchors the thread and replies on an explicit anchor message (reaction summons)', async () => {
    const provider = {
      createThreadFromMessage: vi.fn().mockResolvedValue({
        channelId: 'reacted-1',
        parentChannelId: 'channel-1',
        name: 'Investigate this',
        kind: 'thread',
        messageId: 'reacted-1',
      }),
      editMessage: vi.fn().mockResolvedValue(undefined),
    };
    mocks.answerQuestion.mockResolvedValueOnce('A quick answer');

    await processDiscordFastAgentMessage({
      event: { eventId: 'synthetic-1' } as never,
      question: 'Investigate this',
      sender: { id: 'discord-user-1', username: 'matt' } as never,
      senderUserId: 'user-1',
      provider: provider as never,
      applicationId: 'application-1',
      channel: {
        channelId: 'channel-1',
        channelName: 'general',
        channelType: 0,
        guildId: 'guild-1',
        isDirectMessage: false,
        isThread: false,
      },
      metadata: {
        communicationChannelId: 'channel-1',
        communicationMessageId: 'reacted-1',
        communicationAnchorMessageId: 'reacted-1',
        communicationGuildId: 'guild-1',
      } as never,
      conversationId: 'reacted-1',
      anchorMessageId: 'reacted-1',
    });

    // The synthesized message id ('source-1' from getDiscordMessageCreate) is
    // not a real Discord message; the reacted-on message anchors everything.
    expect(provider.createThreadFromMessage).toHaveBeenCalledWith({
      channelId: 'channel-1',
      messageId: 'reacted-1',
      name: 'Investigate this',
    });
    expect(mocks.answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ currentMessageId: 'reacted-1' }),
    );
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: expect.objectContaining({
          channelId: 'reacted-1',
          isThread: true,
        }),
        replyToMessageId: 'reacted-1',
      }),
    );
  });

  it('continues an existing guild thread without creating another thread', async () => {
    const provider = {
      createThreadFromMessage: vi.fn(),
      editMessage: vi.fn().mockResolvedValue(undefined),
    };
    mocks.answerQuestion.mockResolvedValueOnce('A quick answer');

    await processDiscordFastAgentMessage({
      event: { eventId: 'source-2' } as never,
      question: 'Keep going',
      sender: { id: 'discord-user-1', username: 'matt' } as never,
      senderUserId: 'user-1',
      provider: provider as never,
      applicationId: 'application-1',
      channel: {
        channelId: 'thread-1',
        channelName: 'investigate-this',
        channelType: 11,
        guildId: 'guild-1',
        parentChannelId: 'channel-1',
        isDirectMessage: false,
        isThread: true,
      },
      metadata: {
        communicationChannelId: 'channel-1',
        communicationThreadId: 'thread-1',
        communicationMessageId: 'source-2',
        communicationGuildId: 'guild-1',
      } as never,
      conversationId: 'thread-1',
    });

    expect(provider.createThreadFromMessage).not.toHaveBeenCalled();
    expect(mocks.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: expect.objectContaining({ channelId: 'thread-1' }),
      }),
    );
  });

  it('settles the retry notice before posting a chunked reply', async () => {
    const provider = {
      editMessage: vi.fn().mockResolvedValue(undefined),
    };
    mocks.reply
      .mockResolvedValueOnce({
        provider: 'discord',
        channelId: 'channel-1',
        messageId: 'retry-1',
      })
      .mockResolvedValueOnce({
        provider: 'discord',
        channelId: 'channel-1',
        messageId: 'reply-1',
        lastTextMessageId: 'reply-2',
      });
    mocks.answerQuestion.mockImplementationOnce(
      async ({
        adapter,
      }: {
        adapter: {
          postReply: (reply: unknown) => Promise<{ messageId: string }>;
          replaceReply: (
            handle: { messageId: string },
            reply: unknown,
          ) => Promise<{ messageId: string }>;
        };
      }) => {
        const handle = await adapter.postReply({
          purpose: 'progress',
          message: 'Retrying connection to the inference provider.',
        });
        return adapter.replaceReply(handle, {
          purpose: 'closeout',
          message: 'x'.repeat(2_001),
        });
      },
    );

    await processDiscordFastAgentMessage({
      event: { eventId: 'event-1' } as never,
      question: 'Investigate this',
      sender: { id: 'discord-user-1', username: 'matt' } as never,
      senderUserId: 'user-1',
      provider: provider as never,
      applicationId: 'application-1',
      channel: {
        channelId: 'channel-1',
        guildId: null,
        isDirectMessage: true,
        isThread: false,
      } as never,
      metadata: {
        communicationChannelId: 'channel-1',
      } as never,
      conversationId: 'channel-1',
    });

    expect(provider.editMessage).toHaveBeenCalledWith({
      channelId: 'channel-1',
      messageId: 'retry-1',
      text: 'Reconnected to the inference provider.',
    });
    expect(mocks.reply).toHaveBeenCalledTimes(2);
  });

  it('launches the all-repositories sentinel without resolving an environment', async () => {
    mocks.answerQuestion.mockImplementationOnce(
      async ({
        adapter,
      }: {
        adapter: {
          launchTask: (input: {
            prompt: string;
            environmentId: string;
            parentSessionId: string;
            postKickoff: () => Promise<void>;
          }) => Promise<unknown>;
        };
      }) =>
        adapter.launchTask({
          prompt: 'Update every repository.',
          environmentId: ALL_REPOSITORIES,
          parentSessionId: 'session-1',
          postKickoff: vi.fn().mockResolvedValue(undefined),
        }),
    );

    await processDiscordFastAgentMessage({
      event: { eventId: 'event-1' } as never,
      question: 'Update every repository',
      sender: { id: 'discord-user-1', username: 'matt' } as never,
      senderUserId: 'user-1',
      provider: {} as never,
      applicationId: 'application-1',
      channel: {
        channelId: 'channel-1',
        guildId: null,
        isDirectMessage: true,
        isThread: false,
      } as never,
      metadata: {
        communicationChannelId: 'channel-1',
      } as never,
      conversationId: 'channel-1',
    });

    expect(mocks.resolveWorkspace).not.toHaveBeenCalled();
    expect(mocks.startTask).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceOverride: {
          repoForPayload: ALL_REPOSITORIES,
          workspaceDisplayName: 'all repos',
        },
      }),
    );
  });
});
