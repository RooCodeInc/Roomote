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

  it('returns bounded newest-first pages with an exclusive continuation cursor', async () => {
    const messages = Array.from({ length: 25 }, (_, index) => ({
      provider: 'slack' as const,
      id: String(index + 1),
      user: 'user-1',
      text: `Message ${index + 1}`,
      channelId: 'channel-1',
      fileCount: 0,
    }));
    mocks.lookupChannelMessages.mockImplementation(
      async (input: { latest?: string }) => {
        const boundedMessages = input.latest
          ? messages.filter(
              (message) => Number(message.id) <= Number(input.latest),
            )
          : messages;
        return {
          provider: 'slack',
          channelId: 'channel-1',
          messageCount: boundedMessages.length,
          messages: boundedMessages,
        };
      },
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

    const firstPage = await adapter.getChatChannelMessages({ limit: 2 });
    const secondPage = await adapter.getChatChannelMessages({
      cursor: '24',
      limit: 2,
    });

    expect(firstPage).toMatchObject({
      messageCount: 2,
      hasMore: true,
      nextCursor: '24',
      messages: [{ id: '24' }, { id: '25' }],
    });
    expect(firstPage.continuationHint).toContain('cursor: "24"');
    expect(secondPage).toMatchObject({
      messageCount: 2,
      hasMore: true,
      nextCursor: '22',
      messages: [{ id: '22' }, { id: '23' }],
    });
    expect(mocks.lookupChannelMessages).toHaveBeenLastCalledWith({
      actingUserId: 'user-1',
      channel: 'channel-1',
      latest: '24',
      provider: 'slack',
    });
  });

  it('keeps a page with oversized message content below the Fast byte budget', async () => {
    mocks.lookupChannelMessages.mockResolvedValue({
      provider: 'slack',
      channelId: 'channel-1',
      messageCount: 1,
      messages: [
        {
          provider: 'slack',
          id: '100.1',
          user: 'user-1',
          text: '\u{1f680}'.repeat(20 * 1024),
          channelId: 'channel-1',
          fileCount: 20,
          files: Array.from({ length: 20 }, (_, index) => ({
            id: String(index),
            name: `file-${index}`,
            mimeType: 'text/plain',
            size: 100,
          })),
        },
      ],
    });
    const adapter = createFastAgentChatContextAdapter({
      actingUserId: 'user-1',
      conversation: {
        surface: 'slack',
        workspaceId: 'team-1',
        conversationId: '100.1',
        replyTarget: { channelId: 'channel-1', threadId: '100.1' },
      },
    });

    const page = await adapter.getChatChannelMessages({});
    const serialized = JSON.stringify(page);

    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(32 * 1024);
    expect(serialized).toContain('[message truncated]');
    expect(serialized).not.toContain('\ufffd');
  });
});
