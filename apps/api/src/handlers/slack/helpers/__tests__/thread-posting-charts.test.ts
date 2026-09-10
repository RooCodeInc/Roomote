const mocks = vi.hoisted(() => ({
  footerMessageTs: vi.fn(),
  postWithFooter: vi.fn(),
  recordMessage: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  findSlackConversationSubjectByUserId: vi.fn(async () => null),
  recordSlackConversationMessageBestEffort: mocks.recordMessage,
}));
vi.mock('@roomote/slack', () => ({
  postSlackThreadMessageWithFooterText: mocks.postWithFooter,
  getSlackThreadReplyFooterMessageTs: mocks.footerMessageTs,
  buildSlackThreadReplyFooterBlock: ({
    footerText,
  }: {
    footerText: string;
  }) => ({
    type: 'context',
    text: footerText,
  }),
  withSlackThreadReplyFooterLock: async ({
    fn,
  }: {
    fn: (assertLock: () => Promise<void>) => Promise<unknown>;
  }) => fn(async () => {}),
}));
vi.mock('@roomote/communication', () => ({
  buildFastSessionReplyFooterText: () => 'Session footer',
}));

import type { DataVisualizationInput } from '@roomote/types';

import { postSlackThreadMarkdownMessage } from '../thread-posting';

const chart: DataVisualizationInput = {
  title: 'Monthly Sales',
  chart: {
    type: 'bar',
    series: [
      {
        name: 'Sales',
        data: [
          { label: 'Jan', value: 120 },
          { label: 'Feb', value: 165 },
        ],
      },
    ],
    axis_config: { categories: ['Jan', 'Feb'] },
  },
};
const chartBlock = { type: 'data_visualization', ...chart };
const image = { url: 'https://example.com/image.png', altText: 'Screenshot' };
const imageBlock = {
  type: 'image',
  image_url: image.url,
  alt_text: image.altText,
};

describe('Slack reply chart delivery', () => {
  const slack = {
    hasMessageInThread: vi.fn(),
    postMessage: vi.fn(),
    updateMessage: vi.fn(),
  };
  const base = {
    slack: slack as never,
    channel: 'C1',
    threadTs: '100.1',
    text: 'Here is the chart.',
    charts: [chart],
    images: [image],
  };

  beforeEach(() => {
    vi.resetAllMocks();
    slack.hasMessageInThread.mockResolvedValue(true);
    slack.postMessage.mockResolvedValue('reply-ts');
    slack.updateMessage.mockResolvedValue(true);
    mocks.postWithFooter.mockResolvedValue('reply-ts');
    mocks.footerMessageTs.mockResolvedValue('reply-ts');
  });

  it('posts charts between the Markdown body and images on footer replies', async () => {
    await postSlackThreadMarkdownMessage({
      ...base,
      fastSessionFooter: {
        sessionId: 'session-1',
        linkedPrs: [],
        livePreviewUrl: null,
      },
    });
    expect(mocks.postWithFooter).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        bodyBlocks: [
          { type: 'markdown', text: base.text },
          chartBlock,
          imageBlock,
        ],
      }),
    );
  });

  it('posts charts on plain thread replies', async () => {
    await postSlackThreadMarkdownMessage(base);
    expect(slack.postMessage).toHaveBeenCalledExactlyOnceWith({
      channel: 'C1',
      thread_ts: '100.1',
      text: base.text,
      blocks: [{ type: 'markdown', text: base.text }, chartBlock, imageBlock],
    });
  });

  it('keeps charts when the video fallback rewrites the reply', async () => {
    const fallback = '[View video](https://example.com/video)';
    await postSlackThreadMarkdownMessage({
      ...base,
      fastSessionFooter: {
        sessionId: 'session-1',
        linkedPrs: [],
        livePreviewUrl: null,
      },
      deliverVideos: vi.fn(async () => fallback),
    });
    const text = `${base.text}\n\n${fallback}`;
    expect(slack.updateMessage).toHaveBeenCalledExactlyOnceWith({
      channel: 'C1',
      ts: 'reply-ts',
      message: {
        text,
        blocks: [
          { type: 'markdown', text },
          chartBlock,
          imageBlock,
          { type: 'context', text: 'Session footer' },
        ],
      },
    });
  });

  it('caps a reply at two charts', async () => {
    await postSlackThreadMarkdownMessage({
      ...base,
      images: [],
      charts: [
        chart,
        { ...chart, title: 'Second' },
        { ...chart, title: 'Third' },
      ],
    });
    const blocks = slack.postMessage.mock.calls[0]![0].blocks as Array<{
      type: string;
    }>;
    expect(blocks.map((block) => block.type)).toEqual([
      'markdown',
      'data_visualization',
      'data_visualization',
    ]);
  });

  it('caps images after reserving Markdown, charts, and the sticky footer', async () => {
    const images = Array.from({ length: 48 }, (_, index) => ({
      url: `https://example.com/image-${index}.png`,
      altText: `Screenshot ${index}`,
    }));

    await postSlackThreadMarkdownMessage({
      ...base,
      charts: [chart, { ...chart, title: 'Second' }],
      images,
      fastSessionFooter: {
        sessionId: 'session-1',
        linkedPrs: [],
        livePreviewUrl: null,
      },
      deliverVideos: vi.fn(
        async () => '[View video](https://example.com/video)',
      ),
    });

    const bodyBlocks = mocks.postWithFooter.mock.calls[0]![0]
      .bodyBlocks as Array<{ type: string; image_url?: string }>;
    expect(bodyBlocks).toHaveLength(49);
    expect(bodyBlocks.filter((block) => block.type === 'image')).toHaveLength(
      46,
    );
    expect(bodyBlocks.at(-1)?.image_url).toBe(
      'https://example.com/image-45.png',
    );
    expect(slack.updateMessage.mock.calls[0]![0].message.blocks).toHaveLength(
      50,
    );
  });
});
