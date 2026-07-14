import { describe, expect, it, vi } from 'vitest';

import { SlackCommunicationProvider } from '../communication-provider';
import type { SlackNotifier } from '../slack-notifier';

function buildProvider(postMessageMock: ReturnType<typeof vi.fn>) {
  return new SlackCommunicationProvider({
    postMessage: postMessageMock,
  } as unknown as SlackNotifier);
}

describe('SlackCommunicationProvider.postMessage', () => {
  it('posts plain text without synthesizing blocks', async () => {
    const postMessageMock = vi.fn().mockResolvedValue('111.222');

    await expect(
      buildProvider(postMessageMock).postMessage({
        channelId: 'C123',
        text: 'hello',
      }),
    ).resolves.toEqual({
      provider: 'slack',
      channelId: 'C123',
      messageId: '111.222',
    });

    expect(postMessageMock).toHaveBeenCalledWith({
      channel: 'C123',
      text: 'hello',
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  it('renders link buttons as an actions block and keeps the body visible', async () => {
    const postMessageMock = vi.fn().mockResolvedValue('111.222');

    await buildProvider(postMessageMock).postMessage({
      channelId: 'C123',
      text: 'root summary',
      buttons: [
        [
          { text: 'Go to task', url: 'https://app.example.com/task/1' },
          { text: 'Retry', callbackData: 'retry' },
        ],
      ],
    });

    expect(postMessageMock).toHaveBeenCalledWith({
      channel: 'C123',
      text: 'root summary',
      blocks: [
        {
          type: 'markdown',
          text: 'root summary',
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              action_id: 'communication_link_button_0',
              text: { type: 'plain_text', text: 'Go to task', emoji: false },
              url: 'https://app.example.com/task/1',
            },
          ],
        },
      ],
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  it('ignores callback-only buttons entirely', async () => {
    const postMessageMock = vi.fn().mockResolvedValue('111.222');

    await buildProvider(postMessageMock).postMessage({
      channelId: 'C123',
      text: 'hello',
      buttons: [[{ text: 'Retry', callbackData: 'retry' }]],
    });

    expect(postMessageMock).toHaveBeenCalledWith({
      channel: 'C123',
      text: 'hello',
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  it('appends the actions block after caller-provided blocks without wrapping text', async () => {
    const postMessageMock = vi.fn().mockResolvedValue('111.222');
    const callerBlock = {
      type: 'section',
      text: { type: 'mrkdwn', text: 'x' },
    };

    await buildProvider(postMessageMock).postMessage({
      channelId: 'C123',
      text: 'fallback',
      blocks: [callerBlock],
      buttons: [[{ text: 'Open', url: 'https://example.com' }]],
    });

    const call = postMessageMock.mock.calls[0]?.[0];
    expect(call.blocks[0]).toBe(callerBlock);
    expect(call.blocks[1]).toMatchObject({ type: 'actions' });
    expect(call.blocks).toHaveLength(2);
  });

  it('throws when Slack returns no message timestamp', async () => {
    const postMessageMock = vi.fn().mockResolvedValue(undefined);

    await expect(
      buildProvider(postMessageMock).postMessage({
        channelId: 'C123',
        text: 'hello',
      }),
    ).rejects.toThrow('Slack chat.postMessage returned no message timestamp');
  });
});
