import { getChatChannelMessages } from '../chat-api-client.js';
import { handleGetChatChannelMessages } from '../get-chat-channel-messages.js';
import type { RoomoteConfig } from '../types.js';

vi.mock('../chat-api-client.js');

const config: RoomoteConfig = {
  token: 'test-token',
  platformApiUrl: 'https://platform.example.com',
};

describe('handleGetChatChannelMessages', () => {
  afterEach(() => vi.restoreAllMocks());

  it('trims and forwards provider-neutral channel history parameters', async () => {
    vi.mocked(getChatChannelMessages).mockResolvedValueOnce({
      provider: 'slack',
      channelId: 'C123',
      requestedOldest: '2026-04-01T00:00:00Z',
      requestedLatest: '2026-04-02T00:00:00Z',
      messageCount: 0,
      messages: [],
    });

    const result = await handleGetChatChannelMessages(
      {
        channel: ' #eng ',
        oldest: ' 2026-04-01T00:00:00Z ',
        latest: ' 2026-04-02T00:00:00Z ',
      },
      config,
    );

    expect(result.structuredContent).toMatchObject({
      provider: 'slack',
      channelId: 'C123',
    });
    expect(getChatChannelMessages).toHaveBeenCalledWith(config, {
      channel: '#eng',
      oldest: '2026-04-01T00:00:00Z',
      latest: '2026-04-02T00:00:00Z',
    });
  });
});
