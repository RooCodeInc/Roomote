import { getSlackChannelMessages } from '../slack-api-client.js';
import { handleGetSlackChannelMessages } from '../get-slack-channel-messages.js';
import type { RoomoteConfig } from '../types.js';

vi.mock('../slack-api-client.js');

const config: RoomoteConfig = {
  token: 'test-token',
  platformApiUrl: 'https://platform.example.com',
};

describe('handleGetSlackChannelMessages', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns structured channel history results', async () => {
    vi.mocked(getSlackChannelMessages).mockResolvedValueOnce({
      channelId: 'C123',
      requestedOldest: '2026-04-01T00:00:00Z',
      requestedLatest: '2026-04-02T00:00:00Z',
      messageCount: 2,
      messages: [
        {
          ts: '1711929600.000000',
          user: 'U1',
          username: 'Alice',
          text: 'root',
          fileCount: 0,
        },
        {
          ts: '1711929900.000000',
          user: 'U2',
          username: 'Bob',
          threadTs: '1711929600.000000',
          text: 'reply',
          fileCount: 1,
          files: [
            {
              id: 'F1',
              name: 'screenshot.png',
              mimetype: 'image/png',
              filetype: 'png',
              size: 1024,
            },
          ],
        },
      ],
    });

    const result = await handleGetSlackChannelMessages(
      {
        channel: ' #eng ',
        oldest: ' 2026-04-01T00:00:00Z ',
        latest: ' 2026-04-02T00:00:00Z ',
      },
      config,
    );

    expect(result.structuredContent).toEqual({
      channelId: 'C123',
      requestedOldest: '2026-04-01T00:00:00Z',
      requestedLatest: '2026-04-02T00:00:00Z',
      messageCount: 2,
      messages: [
        {
          ts: '1711929600.000000',
          user: 'U1',
          username: 'Alice',
          text: 'root',
          fileCount: 0,
        },
        {
          ts: '1711929900.000000',
          user: 'U2',
          username: 'Bob',
          threadTs: '1711929600.000000',
          text: 'reply',
          fileCount: 1,
          files: [
            {
              id: 'F1',
              name: 'screenshot.png',
              mimetype: 'image/png',
              filetype: 'png',
              size: 1024,
            },
          ],
        },
      ],
    });
    expect(getSlackChannelMessages).toHaveBeenCalledWith(config, {
      channel: '#eng',
      oldest: '2026-04-01T00:00:00Z',
      latest: '2026-04-02T00:00:00Z',
    });
  });

  it('returns an error result when the lookup fails', async () => {
    vi.mocked(getSlackChannelMessages).mockRejectedValueOnce(
      new Error('forbidden'),
    );

    const result = await handleGetSlackChannelMessages(
      { channel: '#eng' },
      config,
    );

    expect(result.content[0]?.text).toContain('"success":false');
    expect(result.content[0]?.text).toContain('forbidden');
  });
});
