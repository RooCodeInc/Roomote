const {
  lookupSlackThreadMock,
  lookupSlackChannelMessagesMock,
  lookupDiscordThreadMock,
  lookupDiscordChannelMessagesMock,
} = vi.hoisted(() => ({
  lookupSlackThreadMock: vi.fn(),
  lookupSlackChannelMessagesMock: vi.fn(),
  lookupDiscordThreadMock: vi.fn(),
  lookupDiscordChannelMessagesMock: vi.fn(),
}));

vi.mock('../slack-thread-lookup', () => ({
  lookupSlackThread: lookupSlackThreadMock,
  lookupSlackChannelMessages: lookupSlackChannelMessagesMock,
}));

vi.mock('../discord-thread-lookup', () => ({
  lookupDiscordThread: lookupDiscordThreadMock,
  lookupDiscordChannelMessages: lookupDiscordChannelMessagesMock,
}));

import {
  lookupCommunicationChannelMessages,
  lookupCommunicationMessageContext,
} from '../communication-message-lookup';

describe('lookupCommunicationMessageContext', () => {
  afterEach(() => vi.clearAllMocks());

  it('uses the task communication provider without exposing a provider input', async () => {
    lookupSlackThreadMock.mockResolvedValueOnce({
      channelId: 'C123',
      requestedMessageTs: '1710000000.000100',
      threadTs: '1710000000.000000',
      matchedMessageIndex: 0,
      messageCount: 1,
      messages: [
        {
          ts: '1710000000.000100',
          user: 'U1',
          text: 'hello',
          fileCount: 0,
        },
      ],
    });

    const taskRun = {
      payload: { communicationProvider: 'slack' },
      slackChannelId: 'C123',
      slackThreadTs: '1710000000.000000',
      actingUserId: 'user-1',
    };
    const result = await lookupCommunicationMessageContext({
      messageId: '1710000000.000100',
      taskRun,
    });

    expect(lookupSlackThreadMock).toHaveBeenCalledWith({
      messageTs: '1710000000.000100',
      taskRun,
    });
    expect(result).toMatchObject({
      provider: 'slack',
      requestedMessageId: '1710000000.000100',
      threadId: '1710000000.000000',
      messages: [{ provider: 'slack', id: '1710000000.000100' }],
    });
  });

  it('infers Discord from a message link for a web-started task', async () => {
    lookupDiscordThreadMock.mockResolvedValueOnce({
      channelId: '456',
      requestedMessageId: '789',
      threadId: '456',
      matchedMessageIndex: 0,
      messageCount: 1,
      messages: [{ id: '789', user: 'U1', text: 'hello', fileCount: 0 }],
    });

    const taskRun = { payload: {}, actingUserId: 'user-1' };
    const result = await lookupCommunicationMessageContext({
      messageLink: 'https://discord.com/channels/123/456/789',
      taskRun,
    });

    expect(lookupDiscordThreadMock).toHaveBeenCalledWith({
      channel: '456',
      messageId: '789',
      taskRun,
    });
    expect(result.provider).toBe('discord');
  });

  it('infers Slack from a message link for a web-started task', async () => {
    lookupSlackThreadMock.mockResolvedValueOnce({
      channelId: 'C123',
      requestedMessageTs: '1710000000.000100',
      threadTs: '1710000000.000000',
      matchedMessageIndex: 0,
      messageCount: 1,
      messages: [
        {
          ts: '1710000000.000100',
          user: 'U1',
          text: 'hello',
          fileCount: 0,
        },
      ],
    });

    const taskRun = { payload: {}, actingUserId: 'user-1' };
    await lookupCommunicationMessageContext({
      messageLink: 'https://acme.slack.com/archives/C123/p1710000000000100',
      taskRun,
    });

    expect(lookupSlackThreadMock).toHaveBeenCalledWith({
      channel: 'C123',
      messageTs: '1710000000.000100',
      taskRun: { ...taskRun, slackThreadTs: null },
    });
  });

  it('accepts a Slack channel link with a separate message id', async () => {
    lookupSlackThreadMock.mockResolvedValueOnce({
      channelId: 'C123',
      requestedMessageTs: '1710000000.000100',
      threadTs: '1710000000.000000',
      matchedMessageIndex: 0,
      messageCount: 0,
      messages: [],
    });

    await lookupCommunicationMessageContext({
      channel: 'https://acme.slack.com/archives/C123',
      messageId: '1710000000.000100',
      taskRun: { payload: {} },
    });

    expect(lookupSlackThreadMock).toHaveBeenCalledWith({
      channel: 'C123',
      messageTs: '1710000000.000100',
      taskRun: { payload: {}, slackThreadTs: null },
    });
  });

  it('uses an explicit Slack provider for a raw authorized channel id', async () => {
    lookupSlackThreadMock.mockResolvedValueOnce({
      channelId: 'C123',
      requestedMessageTs: '1710000000.000100',
      threadTs: '1710000000.000000',
      matchedMessageIndex: 0,
      messageCount: 0,
      messages: [],
    });

    await lookupCommunicationMessageContext({
      actingUserId: 'user-1',
      channel: 'C123',
      messageId: '1710000000.000100',
      provider: 'slack',
    });

    expect(lookupSlackThreadMock).toHaveBeenCalledWith({
      actingSlackMembershipUserId: 'user-1',
      channel: 'C123',
      messageTs: '1710000000.000100',
    });
  });

  it('does not guess a provider from a raw id when the task has no channel', async () => {
    await expect(
      lookupCommunicationMessageContext({
        messageId: '789',
        taskRun: { payload: {} },
      }),
    ).rejects.toThrow(
      'A Slack or Discord message link is required when the task has no communication channel',
    );
  });
});

describe('lookupCommunicationChannelMessages', () => {
  afterEach(() => vi.clearAllMocks());

  it('uses the task communication channel when channel is omitted', async () => {
    lookupDiscordChannelMessagesMock.mockResolvedValueOnce({
      channelId: '456',
      messageCount: 0,
      messages: [],
    });
    const taskRun = {
      payload: {
        communicationProvider: 'discord',
        communicationChannelId: '456',
      },
      actingUserId: 'user-1',
    };

    const result = await lookupCommunicationChannelMessages({ taskRun });

    expect(lookupDiscordChannelMessagesMock).toHaveBeenCalledWith({ taskRun });
    expect(result).toEqual({
      provider: 'discord',
      channelId: '456',
      messageCount: 0,
      messages: [],
    });
  });

  it('infers a Slack channel from a permalink for a web-started task', async () => {
    lookupSlackChannelMessagesMock.mockResolvedValueOnce({
      channelId: 'C123',
      messageCount: 0,
      messages: [],
    });
    const taskRun = { payload: {}, actingUserId: 'user-1' };

    await lookupCommunicationChannelMessages({
      channel: 'https://acme.slack.com/archives/C123',
      taskRun,
    });

    expect(lookupSlackChannelMessagesMock).toHaveBeenCalledWith({
      channel: 'C123',
      taskRun: { ...taskRun, slackThreadTs: null },
    });
  });

  it('uses an explicit Discord provider for a raw authorized channel id', async () => {
    lookupDiscordChannelMessagesMock.mockResolvedValueOnce({
      channelId: '456',
      messageCount: 0,
      messages: [],
    });

    await lookupCommunicationChannelMessages({
      actingUserId: 'user-1',
      channel: '456',
      provider: 'discord',
    });

    expect(lookupDiscordChannelMessagesMock).toHaveBeenCalledWith({
      actingDiscordMembershipUserId: 'user-1',
      channel: '456',
    });
  });

  it('does not guess a provider from a raw channel when the task has none', async () => {
    await expect(
      lookupCommunicationChannelMessages({
        channel: '456',
        taskRun: { payload: {} },
      }),
    ).rejects.toThrow(
      'A Slack or Discord channel/message link is required when the task has no communication channel',
    );
  });
});
