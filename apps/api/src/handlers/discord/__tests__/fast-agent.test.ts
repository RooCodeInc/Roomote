const mocks = vi.hoisted(() => ({
  acquireLock: vi.fn(),
  answerQuestion: vi.fn(),
  fetchHistory: vi.fn(),
  getMessage: vi.fn(),
  releaseLock: vi.fn(),
  reply: vi.fn(),
  resolveWorkspace: vi.fn(),
  startTask: vi.fn(),
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

vi.mock('@roomote/communication/discord-event', () => ({
  getDiscordMessageCreate: mocks.getMessage,
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
