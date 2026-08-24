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
    });
    expect(mocks.lookupChannelMessages).toHaveBeenCalledWith({
      actingUserId: 'user-1',
      channel: 'channel-1',
      oldest: '99.1',
      latest: '101.1',
      provider: 'slack',
    });
  });

  it('scopes Discord lookups to the routable conversation channel', async () => {
    const adapter = createFastAgentChatContextAdapter({
      actingUserId: 'user-2',
      conversation: {
        surface: 'discord',
        workspaceId: 'guild-1',
        conversationId: 'thread-1',
        replyTarget: { channelId: 'thread-1' },
      },
    });

    await adapter.getChatChannelMessages({});

    expect(mocks.lookupChannelMessages).toHaveBeenCalledWith({
      actingUserId: 'user-2',
      channel: 'thread-1',
      provider: 'discord',
    });
  });
});
