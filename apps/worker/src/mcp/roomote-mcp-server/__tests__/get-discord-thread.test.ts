import { getDiscordThread } from '../discord-api-client.js';
import { handleGetDiscordThread } from '../get-discord-thread.js';
import type { RoomoteConfig } from '../types.js';

vi.mock('../discord-api-client.js');

const config: RoomoteConfig = {
  token: 'test-token',
  platformApiUrl: 'https://platform.example.com',
};

describe('handleGetDiscordThread', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns structured thread lookup results', async () => {
    vi.mocked(getDiscordThread).mockResolvedValueOnce({
      channelId: '456',
      requestedMessageId: '789',
      threadId: '456',
      matchedMessageIndex: 0,
      messageCount: 1,
      messages: [
        {
          id: '789',
          user: 'U1',
          username: 'Ada',
          text: 'hello',
          fileCount: 0,
        },
      ],
    });

    const result = await handleGetDiscordThread(
      {
        messageLink: ' https://discord.com/channels/123/456/789 ',
      },
      config,
    );

    expect(result.structuredContent).toEqual({
      channelId: '456',
      requestedMessageId: '789',
      threadId: '456',
      matchedMessageIndex: 0,
      messageCount: 1,
      messages: [
        {
          id: '789',
          user: 'U1',
          username: 'Ada',
          text: 'hello',
          fileCount: 0,
        },
      ],
    });
    expect(getDiscordThread).toHaveBeenCalledWith(config, {
      messageLink: 'https://discord.com/channels/123/456/789',
    });
  });

  it('returns an error result when the lookup fails', async () => {
    vi.mocked(getDiscordThread).mockRejectedValueOnce(new Error('not found'));

    const result = await handleGetDiscordThread(
      { channel: '456', messageId: '789' },
      config,
    );

    expect(result.content[0]?.text).toContain('"success":false');
    expect(result.content[0]?.text).toContain('not found');
  });
});
