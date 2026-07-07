import { getSlackThread } from '../slack-api-client.js';
import { handleGetSlackThread } from '../get-slack-thread.js';
import type { RoomoteConfig } from '../types.js';

vi.mock('../slack-api-client.js');

const config: RoomoteConfig = {
  token: 'test-token',
  platformApiUrl: 'https://platform.example.com',
};

describe('handleGetSlackThread', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns structured thread lookup results', async () => {
    vi.mocked(getSlackThread).mockResolvedValueOnce({
      channelId: 'C123',
      requestedMessageTs: '111.222',
      threadTs: '111.000',
      matchedMessageIndex: 1,
      messageCount: 2,
      messages: [
        {
          ts: '111.000',
          user: 'U1',
          username: 'Alice',
          text: 'root',
          fileCount: 0,
        },
        {
          ts: '111.222',
          user: 'U2',
          username: 'Bob',
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

    const result = await handleGetSlackThread(
      { channel: ' #eng ', messageTs: '111.222' },
      config,
    );

    expect(result.structuredContent).toEqual({
      channelId: 'C123',
      requestedMessageTs: '111.222',
      threadTs: '111.000',
      matchedMessageIndex: 1,
      messageCount: 2,
      messages: [
        {
          ts: '111.000',
          user: 'U1',
          username: 'Alice',
          text: 'root',
          fileCount: 0,
        },
        {
          ts: '111.222',
          user: 'U2',
          username: 'Bob',
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
    expect(getSlackThread).toHaveBeenCalledWith(config, {
      channel: '#eng',
      messageTs: '111.222',
    });
  });

  it('returns an error result when the lookup fails', async () => {
    vi.mocked(getSlackThread).mockRejectedValueOnce(new Error('not found'));

    const result = await handleGetSlackThread({ messageTs: '111.222' }, config);

    expect(result.content[0]?.text).toContain('"success":false');
    expect(result.content[0]?.text).toContain('not found');
  });
});
