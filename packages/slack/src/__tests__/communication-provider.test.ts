import { describe, expect, it, vi } from 'vitest';

import { SlackCommunicationProvider } from '../communication-provider';
import { SlackPostDeliveryError } from '../post-message-delivery';
import type { SlackNotifier } from '../slack-notifier';

function buildProvider(postMessageDetailedMock: ReturnType<typeof vi.fn>) {
  return new SlackCommunicationProvider({
    postMessageDetailed: postMessageDetailedMock,
  } as unknown as SlackNotifier);
}

describe('SlackCommunicationProvider.postMessage', () => {
  it('posts plain text without synthesizing blocks', async () => {
    const postMessageMock = vi.fn().mockResolvedValue({ ts: '111.222' });

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
    const postMessageMock = vi.fn().mockResolvedValue({ ts: '111.222' });

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
          type: 'section',
          text: { type: 'mrkdwn', text: 'root summary' },
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
    const postMessageMock = vi.fn().mockResolvedValue({ ts: '111.222' });

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
    const postMessageMock = vi.fn().mockResolvedValue({ ts: '111.222' });
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

  it('preserves Slack error details when posting fails', async () => {
    const postMessageMock = vi
      .fn()
      .mockResolvedValue({ slackErrorCode: 'invalid_blocks' });

    const error = await buildProvider(postMessageMock)
      .postMessage({
        channelId: 'C123',
        text: 'hello',
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SlackPostDeliveryError);
    expect(error).toMatchObject({ slackErrorCode: 'invalid_blocks' });
  });

  it('retries invalid blocks with caller-provided fallback blocks', async () => {
    const postMessageMock = vi
      .fn()
      .mockResolvedValueOnce({ slackErrorCode: 'invalid_blocks' })
      .mockResolvedValueOnce({ ts: '111.222' });
    const provider = buildProvider(postMessageMock);

    await expect(
      provider.postMessage({
        channelId: 'C123',
        text: 'fallback text',
        blocks: [{ type: 'image', image_url: 'https://example.com/shot.png' }],
        fallbackBlocks: [
          { type: 'section', text: { type: 'mrkdwn', text: 'summary' } },
        ],
      }),
    ).resolves.toMatchObject({ messageId: '111.222' });

    expect(postMessageMock).toHaveBeenCalledTimes(2);
    expect(postMessageMock.mock.calls[0]?.[0]?.blocks).toEqual([
      { type: 'image', image_url: 'https://example.com/shot.png' },
    ]);
    expect(postMessageMock.mock.calls[1]?.[0]?.blocks).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: 'summary' } },
    ]);
  });

  it('does not use fallback blocks after an ambiguous transport failure', async () => {
    const postMessageMock = vi.fn().mockResolvedValue({ transportError: true });
    const provider = buildProvider(postMessageMock);

    await expect(
      provider.postMessage({
        channelId: 'C123',
        blocks: [{ type: 'image', image_url: 'https://example.com/shot.png' }],
        fallbackBlocks: [{ type: 'section' }],
      }),
    ).rejects.toMatchObject({ transportError: true });
    expect(postMessageMock).toHaveBeenCalledOnce();
  });
});

describe('SlackCommunicationProvider channel targets', () => {
  it('delegates channel resolution and app-membership checks', async () => {
    const resolveChannelId = vi.fn().mockResolvedValue('C123');
    const isAppInChannel = vi.fn().mockResolvedValue(true);
    const provider = new SlackCommunicationProvider({
      resolveChannelId,
      isAppInChannel,
    } as unknown as SlackNotifier);

    await expect(provider.resolveChannelId('#eng')).resolves.toBe('C123');
    await expect(provider.isAppInChannel('C123')).resolves.toBe(true);
    expect(resolveChannelId).toHaveBeenCalledWith('#eng');
    expect(isAppInChannel).toHaveBeenCalledWith('C123');
  });
});
