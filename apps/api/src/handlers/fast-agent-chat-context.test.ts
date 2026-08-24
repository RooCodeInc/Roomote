const mocks = vi.hoisted(() => ({
  lookupChannelMessages: vi.fn(),
  lookupMessageContext: vi.fn(),
}));

vi.mock('./mcp/communication-message-lookup', () => ({
  lookupCommunicationChannelMessages: mocks.lookupChannelMessages,
  lookupCommunicationMessageContext: mocks.lookupMessageContext,
}));

import { createFastAgentChatContextAdapter } from './fast-agent-chat-context';

describe('createFastAgentChatContextAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.lookupMessageContext.mockResolvedValue({ messages: [] });
    mocks.lookupChannelMessages.mockResolvedValue({ messages: [] });
  });

  it('scopes Slack lookups to the conversation channel and acting user', async () => {
    const adapter = createFastAgentChatContextAdapter({
      actingUserId: 'user-1',
      conversation: {
        surface: 'slack',
        workspaceId: 'team-1',
        conversationId: '100.1',
        replyTarget: { channelId: 'channel-1', threadId: '100.1' },
      },
    });

    await adapter.getChatMessageContext({ messageId: '100.2' });
    await adapter.getChatChannelMessages({ oldest: '99.1', latest: '101.1' });

    expect(mocks.lookupMessageContext).toHaveBeenCalledWith({
      actingUserId: 'user-1',
      channel: 'channel-1',
      messageId: '100.2',
      provider: 'slack',
      slackTeamId: 'team-1',
    });
    expect(mocks.lookupChannelMessages).toHaveBeenCalledWith({
      actingUserId: 'user-1',
      channel: 'channel-1',
      oldest: '99.1',
      latest: '101.1',
      provider: 'slack',
      slackTeamId: 'team-1',
    });
  });

  it('scopes Discord lookups to the active thread instead of its parent channel', async () => {
    const adapter = createFastAgentChatContextAdapter({
      actingUserId: 'user-2',
      conversation: {
        surface: 'discord',
        workspaceId: 'guild-1',
        conversationId: 'thread-1',
        replyTarget: { channelId: 'parent-1', threadId: 'thread-1' },
      },
    });

    await adapter.getChatMessageContext({ messageId: 'message-1' });
    await adapter.getChatChannelMessages({});

    expect(mocks.lookupMessageContext).toHaveBeenCalledWith({
      actingUserId: 'user-2',
      channel: 'thread-1',
      messageId: 'message-1',
      provider: 'discord',
    });
    expect(mocks.lookupChannelMessages).toHaveBeenCalledWith({
      actingUserId: 'user-2',
      channel: 'thread-1',
      provider: 'discord',
    });
  });

  it('uses Slack channel references instead of the conversation channel for cross-channel lookups', async () => {
    const adapter = createFastAgentChatContextAdapter({
      actingUserId: 'user-1',
      conversation: {
        surface: 'slack',
        workspaceId: 'team-1',
        conversationId: '100.1',
        replyTarget: { channelId: 'channel-1', threadId: '100.1' },
      },
    });
    await adapter.getChatMessageContext({
      channel: 'COTHER',
      messageId: '1710000000.000100',
    });
    await adapter.getChatChannelMessages({ channel: '#other' });

    expect(mocks.lookupMessageContext).toHaveBeenCalledWith({
      actingUserId: 'user-1',
      channel: 'COTHER',
      messageId: '1710000000.000100',
      provider: 'slack',
      slackTeamId: 'team-1',
    });
    expect(mocks.lookupChannelMessages).toHaveBeenCalledWith({
      actingUserId: 'user-1',
      channel: '#other',
      provider: 'slack',
      slackTeamId: 'team-1',
    });
  });

  it('uses Discord permalinks instead of the active thread for cross-channel lookups', async () => {
    const adapter = createFastAgentChatContextAdapter({
      actingUserId: 'user-2',
      conversation: {
        surface: 'discord',
        workspaceId: 'guild-1',
        conversationId: 'thread-1',
        replyTarget: { channelId: 'parent-1', threadId: 'thread-1' },
      },
    });
    const messageLink = 'https://discord.com/channels/123/456/789';
    const channelReference = 'https://discord.com/channels/123/456';

    await adapter.getChatMessageContext({ messageLink });
    await adapter.getChatChannelMessages({ channel: channelReference });

    expect(mocks.lookupMessageContext).toHaveBeenCalledWith({
      actingUserId: 'user-2',
      messageLink,
      provider: 'discord',
    });
    expect(mocks.lookupChannelMessages).toHaveBeenCalledWith({
      actingUserId: 'user-2',
      channel: channelReference,
      provider: 'discord',
    });
  });

  it('propagates cross-channel access denials from the shared lookup', async () => {
    mocks.lookupMessageContext.mockRejectedValueOnce(
      new Error('Linked Slack user is not a member of channel CPRIVATE.'),
    );
    const adapter = createFastAgentChatContextAdapter({
      actingUserId: 'user-1',
      conversation: {
        surface: 'slack',
        workspaceId: 'team-1',
        conversationId: '100.1',
        replyTarget: { channelId: 'channel-1', threadId: '100.1' },
      },
    });

    await expect(
      adapter.getChatMessageContext({
        channel: 'CPRIVATE',
        messageId: '1710000000.000100',
      }),
    ).rejects.toThrow('Linked Slack user is not a member of channel CPRIVATE.');
  });
});
