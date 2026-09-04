import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetFooterTs,
  mockSetFooterTs,
  mockResolveFooterContext,
  mockBuildFooterText,
  mockRedisSet,
  mockRedisEval,
  mockRelocate,
} = vi.hoisted(() => ({
  mockGetFooterTs: vi.fn(),
  mockSetFooterTs: vi.fn(),
  mockResolveFooterContext: vi.fn(),
  mockBuildFooterText: vi.fn(),
  mockRedisSet: vi.fn(),
  mockRedisEval: vi.fn(),
  mockRelocate: vi.fn(),
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

vi.mock('../relocate-active-task-cards', () => ({
  relocateSlackThreadActiveTaskCards: mockRelocate,
}));
vi.mock('../thread-reply-stream', () => ({
  beginSlackThreadReplyStream: vi.fn(),
  endSlackThreadReplyStream: vi.fn(),
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
  finalizeSlackThreadReplyStreamWithFooterText,
  isSlackThreadReplyFooterBlock,
  postSlackThreadMessageWithStickyFooter,
  removeSlackThreadReplyFooter,
} from '../thread-reply-footer-ops';

describe('thread-reply-footer-ops', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisSet.mockResolvedValue('OK');
    mockRedisEval.mockResolvedValue(1);
    mockRelocate.mockResolvedValue(undefined);
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
      getRawMessage: vi.fn(),
      deleteMessage: vi.fn().mockResolvedValue(true),
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

  it('relocates canonical cards before posting the footer carrier', async () => {
    const slack = {
      postMessage: vi.fn().mockResolvedValue('222.000'),
      getMessageBlocks: vi.fn().mockResolvedValue([
        { type: 'markdown', text: 'old body' },
        {
          type: 'context',
          block_id: 'roomote_thread_reply_footer',
          elements: [{ type: 'mrkdwn', text: 'old footer' }],
        },
      ]),
      updateMessage: vi.fn().mockResolvedValue(true),
      getRawMessage: vi.fn(),
      deleteMessage: vi.fn().mockResolvedValue(true),
    };

    await postSlackThreadMessageWithStickyFooter({
      slack,
      channel: 'C1',
      threadTs: '100.000',
      taskId: 'task-1',
      text: 'new reply',
    });

    expect(mockRelocate).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'C1', threadTs: '100.000' }),
    );
    expect(mockRelocate.mock.invocationCallOrder[0]).toBeLessThan(
      slack.postMessage.mock.invocationCallOrder[0]!,
    );
    const postedBlocks = slack.postMessage.mock.calls[0]?.[0]?.blocks;
    expect(postedBlocks).toHaveLength(2);
    expect(postedBlocks[1]).toMatchObject({
      block_id: 'roomote_thread_reply_footer',
    });
    expect(slack.updateMessage).toHaveBeenCalledWith({
      channel: 'C1',
      ts: '111.000',
      message: { blocks: [{ type: 'markdown', text: 'old body' }] },
    });
  });

  it('posts the primary reply when card relocation state is unavailable', async () => {
    mockRelocate.mockRejectedValueOnce(new Error('redis unavailable'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const slack = {
      postMessage: vi.fn().mockResolvedValue('222.000'),
      getMessageBlocks: vi.fn().mockResolvedValue([]),
      updateMessage: vi.fn().mockResolvedValue(true),
      getRawMessage: vi.fn(),
      deleteMessage: vi.fn().mockResolvedValue(true),
    };

    await expect(
      postSlackThreadMessageWithStickyFooter({
        slack,
        channel: 'C1',
        threadTs: '100.000',
        taskId: 'task-1',
        text: 'new reply',
      }),
    ).resolves.toBe('222.000');
    expect(slack.postMessage).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('Failed to relocate active task cards'),
    );
  });

  it('finalizes all streamed reply content before relocating cards and posting the footer', async () => {
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
      getRawMessage: vi.fn(),
      postMessage: vi.fn().mockResolvedValue('footer-new'),
      deleteMessage: vi.fn().mockResolvedValue(true),
    };

    await expect(
      finalizeSlackThreadReplyStreamWithFooterText({
        slack,
        channel: 'C1',
        threadTs: '100.000',
        messageTs: '333.000',
        text: 'final reply',
        bodyBlocks: [{ type: 'markdown', text: 'final reply' }],
        footerText: 'footer',
        streamToken: 'stream-token',
      }),
    ).resolves.toBe(true);

    expect(slack.updateMessage).toHaveBeenNthCalledWith(1, {
      channel: 'C1',
      ts: '333.000',
      message: {
        text: 'final reply',
        blocks: [{ type: 'markdown', text: 'final reply' }],
      },
    });
    expect(slack.updateMessage.mock.invocationCallOrder[0]).toBeLessThan(
      mockRelocate.mock.invocationCallOrder[0]!,
    );
    expect(mockRelocate.mock.invocationCallOrder[0]).toBeLessThan(
      slack.postMessage.mock.invocationCallOrder[0]!,
    );
    expect(slack.postMessage).toHaveBeenCalledWith({
      channel: 'C1',
      thread_ts: '100.000',
      text: 'footer',
      blocks: [
        expect.objectContaining({ block_id: 'roomote_thread_reply_footer' }),
      ],
    });
    // The prior carrier loses its footer and the pointer moves.
    expect(slack.updateMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ ts: '111.000' }),
    );
    expect(mockSetFooterTs).toHaveBeenCalledWith('C1', '100.000', 'footer-new');
  });

  it('deletes a new footer carrier when its pointer cannot be saved', async () => {
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
      getRawMessage: vi.fn(),
      postMessage: vi.fn().mockResolvedValue('footer-new'),
      deleteMessage: vi.fn().mockResolvedValue(true),
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      finalizeSlackThreadReplyStreamWithFooterText({
        slack,
        channel: 'C1',
        threadTs: '100.000',
        messageTs: '333.000',
        text: 'final reply',
        bodyBlocks: [{ type: 'markdown', text: 'final reply' }],
        footerText: 'footer',
        streamToken: 'stream-token',
      }),
    ).resolves.toBe(true);

    expect(slack.deleteMessage).toHaveBeenCalledWith({
      channel: 'C1',
      ts: 'footer-new',
    });
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
