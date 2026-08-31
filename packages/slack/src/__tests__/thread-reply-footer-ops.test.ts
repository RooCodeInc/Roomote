import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetFooterTs,
  mockSetFooterTs,
  mockResolveFooterContext,
  mockBuildFooterText,
  mockRedisSet,
  mockRedisEval,
} = vi.hoisted(() => ({
  mockGetFooterTs: vi.fn(),
  mockSetFooterTs: vi.fn(),
  mockResolveFooterContext: vi.fn(),
  mockBuildFooterText: vi.fn(),
  mockRedisSet: vi.fn(),
  mockRedisEval: vi.fn(),
}));

vi.mock('@roomote/env', () => ({
  Env: { R_APP_URL: 'https://app.example.com' },
}));

vi.mock('@roomote/redis', () => ({
  getRedis: () => ({
    set: mockRedisSet,
    eval: mockRedisEval,
  }),
}));

vi.mock('../slack-messages', () => ({
  getSlackThreadReplyFooterMessageTs: mockGetFooterTs,
  setSlackThreadReplyFooterMessageTs: mockSetFooterTs,
}));

vi.mock('../thread-footer', () => ({
  resolveSlackThreadFooterContext: mockResolveFooterContext,
  buildSlackThreadFooterText: mockBuildFooterText,
}));

import {
  isSlackThreadReplyFooterBlock,
  postSlackThreadMessageWithFooterText,
  postSlackThreadMessageWithStickyFooter,
  removeSlackThreadReplyFooter,
} from '../thread-reply-footer-ops';

describe('thread-reply-footer-ops', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisSet.mockResolvedValue('OK');
    mockRedisEval.mockResolvedValue(1);
    mockGetFooterTs.mockResolvedValue('111.000');
    mockSetFooterTs.mockResolvedValue(undefined);
    mockResolveFooterContext.mockResolvedValue({
      linkedPrs: [{ prNumber: 7, prUrl: 'https://github.com/o/r/pull/7' }],
      livePreviewUrl: null,
      explicitMentionRequired: false,
    });
    mockBuildFooterText.mockReturnValue(
      '_Working on <https://github.com/o/r/pull/7|PR #7>, reply or use the <https://app.example.com/task/t1|web app>._',
    );
  });

  it('detects footer context blocks by block_id and text shape', () => {
    expect(
      isSlackThreadReplyFooterBlock({
        type: 'context',
        block_id: 'roomote_thread_reply_footer',
        elements: [{ type: 'mrkdwn', text: 'x' }],
      }),
    ).toBe(true);

    expect(
      isSlackThreadReplyFooterBlock({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: '_Working on <https://example.com|PR #1>, reply or use the <https://app|web app>._',
          },
        ],
      }),
    ).toBe(true);

    expect(
      isSlackThreadReplyFooterBlock({
        type: 'section',
        text: { type: 'mrkdwn', text: 'hello' },
      }),
    ).toBe(false);
  });

  it('posts with footer, strips the previous footer message, and tracks the new ts', async () => {
    const slack = {
      postMessage: vi.fn().mockResolvedValue('222.000'),
      getOwnMessageContent: vi.fn().mockResolvedValue({
        text: 'old fallback',
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: 'old body' } },
          { type: 'divider' },
          {
            type: 'context',
            block_id: 'roomote_thread_reply_footer',
            elements: [{ type: 'mrkdwn', text: 'old footer' }],
          },
        ],
      }),
      updateMessage: vi.fn().mockResolvedValue(true),
    };

    const ts = await postSlackThreadMessageWithStickyFooter({
      slack,
      channel: 'C1',
      threadTs: '100.000',
      taskId: 'task-1',
      text: 'review summary',
    });

    expect(ts).toBe('222.000');
    expect(slack.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C1',
        thread_ts: '100.000',
        text: 'review summary',
        blocks: expect.arrayContaining([
          expect.objectContaining({
            type: 'context',
            block_id: 'roomote_thread_reply_footer',
          }),
        ]),
      }),
    );
    expect(mockBuildFooterText).toHaveBeenCalledWith(
      expect.objectContaining({
        linkedPrs: [{ prNumber: 7, prUrl: 'https://github.com/o/r/pull/7' }],
      }),
    );
    expect(slack.updateMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C1',
        ts: '111.000',
        message: {
          text: 'old fallback',
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: 'old body' } },
            { type: 'divider' },
          ],
        },
      }),
    );
    expect(mockSetFooterTs).toHaveBeenCalledWith('C1', '100.000', '222.000');

    mockBuildFooterText.mockClear();
    slack.postMessage.mockClear();

    await postSlackThreadMessageWithStickyFooter({
      slack,
      channel: 'C1',
      threadTs: '100.000',
      taskId: 'task-1',
      text: 'PR closed',
      footerStyle: 'reply-only',
    });

    expect(mockBuildFooterText).toHaveBeenCalledWith(
      expect.objectContaining({
        linkedPrs: [],
        livePreviewUrl: null,
      }),
    );
  });

  it('no-ops remove when footer block is already absent', async () => {
    const slack = {
      getOwnMessageContent: vi.fn().mockResolvedValue({
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'body' } }],
      }),
      updateMessage: vi.fn(),
    };

    await removeSlackThreadReplyFooter({
      slack,
      channel: 'C1',
      threadTs: '100.000',
      messageTs: '111.000',
    });

    expect(slack.updateMessage).not.toHaveBeenCalled();
  });

  it('attaches the footer to the first bot reply without attempting cleanup', async () => {
    mockGetFooterTs.mockResolvedValue(null);
    const slack = {
      postMessage: vi.fn().mockResolvedValue('111.000'),
      getOwnMessageContent: vi.fn(),
      updateMessage: vi.fn(),
    };

    await postSlackThreadMessageWithFooterText({
      slack,
      channel: 'C1',
      threadTs: '100.000',
      text: 'first reply',
      bodyBlocks: [{ type: 'markdown', text: 'first reply' }],
      footerText: '_Reply or use the <https://app.example.com|web app>._',
    });

    expect(slack.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        blocks: [
          { type: 'markdown', text: 'first reply' },
          expect.objectContaining({
            block_id: 'roomote_thread_reply_footer',
          }),
        ],
      }),
    );
    expect(slack.getOwnMessageContent).not.toHaveBeenCalled();
    expect(slack.updateMessage).not.toHaveBeenCalled();
    expect(mockSetFooterTs).toHaveBeenCalledWith('C1', '100.000', '111.000');
  });

  it('posts and tracks the new footer when prior-footer cleanup fails', async () => {
    const slack = {
      postMessage: vi.fn().mockResolvedValue('222.000'),
      getOwnMessageContent: vi
        .fn()
        .mockRejectedValue(new Error('Slack unavailable')),
      updateMessage: vi.fn(),
    };

    await expect(
      postSlackThreadMessageWithFooterText({
        slack,
        channel: 'C1',
        threadTs: '100.000',
        text: 'new reply',
        bodyBlocks: [{ type: 'markdown', text: 'new reply' }],
        footerText: '_Reply or use the <https://app.example.com|web app>._',
      }),
    ).resolves.toBe('222.000');

    expect(slack.postMessage).toHaveBeenCalledOnce();
    expect(mockSetFooterTs).toHaveBeenCalledWith('C1', '100.000', '222.000');
  });

  it('does not remove the footer when a retry resolves to the tracked message', async () => {
    const slack = {
      postMessage: vi.fn().mockResolvedValue('111.000'),
      getOwnMessageContent: vi.fn(),
      updateMessage: vi.fn(),
    };

    await postSlackThreadMessageWithFooterText({
      slack,
      channel: 'C1',
      threadTs: '100.000',
      text: 'retried reply',
      bodyBlocks: [{ type: 'markdown', text: 'retried reply' }],
      footerText: '_Reply or use the <https://app.example.com|web app>._',
      clientMsgId: 'stable-client-id',
    });

    expect(slack.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ client_msg_id: 'stable-client-id' }),
    );
    expect(slack.getOwnMessageContent).not.toHaveBeenCalled();
    expect(slack.updateMessage).not.toHaveBeenCalled();
    expect(mockSetFooterTs).toHaveBeenCalledWith('C1', '100.000', '111.000');
  });
});
