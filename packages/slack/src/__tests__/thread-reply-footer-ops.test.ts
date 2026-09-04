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
  postSlackThreadMessageWithStickyFooter,
  removeSlackThreadReplyFooter,
  updateSlackThreadMessageWithFooterText,
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
      getMessageBlocks: vi.fn().mockResolvedValue([
        { type: 'section', text: { type: 'mrkdwn', text: 'old body' } },
        {
          type: 'context',
          block_id: 'roomote_thread_reply_footer',
          elements: [{ type: 'mrkdwn', text: 'old footer' }],
        },
      ]),
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
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: 'old body' } },
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

  it('rewrites an existing message into the footer carrier and strips the previous one', async () => {
    const slack = {
      getMessageBlocks: vi.fn().mockResolvedValue([
        { type: 'section', text: { type: 'mrkdwn', text: 'old body' } },
        {
          type: 'context',
          block_id: 'roomote_thread_reply_footer',
          elements: [{ type: 'mrkdwn', text: 'old footer' }],
        },
      ]),
      updateMessage: vi.fn().mockResolvedValue(true),
    };

    await expect(
      updateSlackThreadMessageWithFooterText({
        slack,
        channel: 'C1',
        threadTs: '100.000',
        messageTs: '333.000',
        text: 'final reply',
        bodyBlocks: [{ type: 'markdown', text: 'final reply' }],
        footerText: 'footer',
      }),
    ).resolves.toBe(true);

    expect(slack.updateMessage).toHaveBeenNthCalledWith(1, {
      channel: 'C1',
      ts: '333.000',
      message: {
        text: 'final reply',
        blocks: [
          { type: 'markdown', text: 'final reply' },
          expect.objectContaining({
            type: 'context',
            block_id: 'roomote_thread_reply_footer',
          }),
        ],
      },
    });
    // The prior carrier loses its footer and the pointer moves.
    expect(slack.updateMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ ts: '111.000' }),
    );
    expect(mockSetFooterTs).toHaveBeenCalledWith('C1', '100.000', '333.000');
  });

  it('takes the footer back off a rewritten message when the pointer cannot be saved', async () => {
    mockGetFooterTs.mockResolvedValue(null);
    mockSetFooterTs.mockRejectedValue(new Error('redis down'));
    const slack = {
      getMessageBlocks: vi.fn().mockResolvedValue([
        { type: 'markdown', text: 'final reply' },
        {
          type: 'context',
          block_id: 'roomote_thread_reply_footer',
          elements: [{ type: 'mrkdwn', text: 'footer' }],
        },
      ]),
      updateMessage: vi.fn().mockResolvedValue(true),
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      updateSlackThreadMessageWithFooterText({
        slack,
        channel: 'C1',
        threadTs: '100.000',
        messageTs: '333.000',
        text: 'final reply',
        bodyBlocks: [{ type: 'markdown', text: 'final reply' }],
        footerText: 'footer',
      }),
    ).resolves.toBe(true);

    expect(slack.updateMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ts: '333.000',
        message: { blocks: [{ type: 'markdown', text: 'final reply' }] },
      }),
    );
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to persist latest footer message ts'),
    );
  });

  it('no-ops remove when footer block is already absent', async () => {
    const slack = {
      getMessageBlocks: vi
        .fn()
        .mockResolvedValue([
          { type: 'section', text: { type: 'mrkdwn', text: 'body' } },
        ]),
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
});
