import { getChatMessageContext } from '../chat-api-client.js';
import { handleGetChatMessageContext } from '../get-chat-message-context.js';
import type { RoomoteConfig } from '../types.js';

vi.mock('../chat-api-client.js');

const config: RoomoteConfig = {
  token: 'test-token',
  platformApiUrl: 'https://platform.example.com',
};

describe('handleGetChatMessageContext', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns normalized communication context', async () => {
    vi.mocked(getChatMessageContext).mockResolvedValueOnce({
      provider: 'discord',
      channelId: '456',
      requestedMessageId: '789',
      threadId: '456',
      matchedMessageIndex: 0,
      messageCount: 1,
      messages: [
        {
          provider: 'discord',
          id: '789',
          user: 'U1',
          username: 'Ada',
          text: 'hello',
          channelId: '456',
          threadId: '456',
          fileCount: 0,
        },
      ],
    });

    const result = await handleGetChatMessageContext(
      {
        messageLink: ' https://discord.com/channels/123/456/789 ',
      },
      config,
    );

    expect(result.structuredContent).toMatchObject({
      provider: 'discord',
      requestedMessageId: '789',
      messageCount: 1,
    });
    expect(getChatMessageContext).toHaveBeenCalledWith(config, {
      messageLink: 'https://discord.com/channels/123/456/789',
    });
  });

  it('returns an error result when the lookup fails', async () => {
    vi.mocked(getChatMessageContext).mockRejectedValueOnce(
      new Error('not found'),
    );

    const result = await handleGetChatMessageContext(
      { channel: '456', messageId: '789' },
      config,
    );

    expect(result.content[0]?.text).toContain('"success":false');
    expect(result.content[0]?.text).toContain('not found');
  });
});
