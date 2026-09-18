import { describe, expect, it } from 'vitest';

import { buildFastAgentSlackReplyBodyBlocks } from './fast-agent-slack-reply-blocks';

describe('buildFastAgentSlackReplyBodyBlocks', () => {
  it('orders fallback Markdown before native charts and images', () => {
    expect(
      buildFastAgentSlackReplyBodyBlocks({
        message: 'Traffic increased this week.',
        charts: [
          {
            title: 'Traffic sources',
            chart: {
              type: 'pie',
              segments: [{ label: 'Search', value: 65 }],
            },
          },
        ],
        images: [{ url: 'https://example.com/proof.png', altText: 'Proof' }],
      }),
    ).toEqual([
      { type: 'markdown', text: 'Traffic increased this week.' },
      {
        type: 'data_visualization',
        title: 'Traffic sources',
        chart: {
          type: 'pie',
          segments: [{ label: 'Search', value: 65 }],
        },
      },
      {
        type: 'image',
        image_url: 'https://example.com/proof.png',
        alt_text: 'Proof',
      },
    ]);
  });

  it('orders continuation context before the quoted request and response', () => {
    expect(
      buildFastAgentSlackReplyBodyBlocks({
        leadingText: 'Continued on web · 2 intervening messages',
        quote: '>*You:* Check it again.',
        message: 'The new response.',
      }),
    ).toEqual([
      {
        type: 'markdown',
        text: 'Continued on web · 2 intervening messages',
      },
      {
        type: 'section',
        block_id: 'roomote_thread_reply_quote',
        text: { type: 'mrkdwn', text: '>*You:* Check it again.' },
      },
      { type: 'markdown', text: 'The new response.' },
    ]);
  });

  it('reserves one of Slack message limits for the sticky footer', () => {
    const blocks = buildFastAgentSlackReplyBodyBlocks({
      message: 'Report',
      charts: [
        {
          title: 'Traffic sources',
          chart: {
            type: 'pie',
            segments: [{ label: 'Search', value: 65 }],
          },
        },
      ],
      images: Array.from({ length: 50 }, (_, index) => ({
        url: `https://example.com/${index}.png`,
        altText: `Proof ${index}`,
      })),
    });

    expect(blocks).toHaveLength(49);
    expect(blocks[0]).toEqual({ type: 'markdown', text: 'Report' });
    expect(blocks[1]).toMatchObject({ type: 'data_visualization' });
    expect(blocks.at(-1)).toMatchObject({ alt_text: 'Proof 46' });
  });
});
