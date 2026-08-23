const mocks = vi.hoisted(() => ({
  acquireLock: vi.fn(),
  answerQuestion: vi.fn(),
  fetchHistory: vi.fn(),
  getMessage: vi.fn(),
  releaseLock: vi.fn(),
  reply: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  acquireFastAgentTurnLock: mocks.acquireLock,
  answerFastAgentQuestion: mocks.answerQuestion,
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

import { processDiscordFastAgentMessage } from '../fast-agent.js';

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
      text: 'Fast mode reconnected to the inference provider.',
    });
    expect(mocks.reply).toHaveBeenCalledTimes(2);
  });
});
