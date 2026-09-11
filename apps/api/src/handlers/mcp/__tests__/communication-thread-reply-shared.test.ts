import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  buildThreadReplyFooterTextMock,
  deliverSharedThreadReplyFooterMock,
  resolveThreadReplyFooterContextMock,
} = vi.hoisted(() => ({
  buildThreadReplyFooterTextMock: vi.fn(),
  deliverSharedThreadReplyFooterMock: vi.fn(),
  resolveThreadReplyFooterContextMock: vi.fn(),
}));

vi.mock('@roomote/communication/thread-reply-footer-delivery', () => ({
  deliverManagedThreadReplyFooter: deliverSharedThreadReplyFooterMock,
}));

vi.mock('@roomote/communication', async () => {
  const actual = await vi.importActual<typeof import('@roomote/communication')>(
    '@roomote/communication',
  );

  return {
    ...actual,
    buildThreadReplyFooterText: buildThreadReplyFooterTextMock,
    resolveThreadReplyFooterContext: resolveThreadReplyFooterContextMock,
  };
});

vi.mock('../chat-reply-helpers', () => ({
  buildThreadReplyImageBlocks: vi.fn(),
  errorResponseForThreadReplyImageError: vi.fn(),
}));

vi.mock('@roomote/env', () => ({
  Env: { R_APP_URL: 'https://app.example.com' },
}));

import {
  buildCommunicationThreadReplyFooterText,
  deliverManagedThreadReplyFooter,
} from '../communication-thread-reply-shared';

describe('deliverManagedThreadReplyFooter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deliverSharedThreadReplyFooterMock.mockImplementation(async (params) =>
      params.postReplyWithFooter(),
    );
    resolveThreadReplyFooterContextMock.mockResolvedValue({
      linkedPrs: [],
      livePreviewUrl: null,
    });
  });

  it('delegates carrier lifecycle ownership to the communication package', async () => {
    const clearPreviousFooter = vi.fn().mockResolvedValue(undefined);
    const postReplyWithFooter = vi.fn().mockResolvedValue({
      messageId: 'new-message',
      textWithoutFooter: 'Latest reply',
    });
    const reply = await deliverManagedThreadReplyFooter({
      provider: 'teams',
      providerLabel: 'Teams',
      channelId: 'channel-1',
      footerStateThreadId: 'thread-1',
      lockKey: 'lock-1',
      runId: 42,
      logContext: 'testContext',
      postReplyWithFooter,
      clearPreviousFooter,
    });
    expect(deliverSharedThreadReplyFooterMock).toHaveBeenCalledWith({
      provider: 'teams',
      providerLabel: 'Teams',
      channelId: 'channel-1',
      footerStateThreadId: 'thread-1',
      lockKey: 'lock-1',
      logContext: 'testContext',
      postReplyWithFooter,
      clearPreviousFooter,
      logRef: 'task run 42',
    });
    expect(reply).toEqual({
      messageId: 'new-message',
      textWithoutFooter: 'Latest reply',
    });
  });
});

describe('buildCommunicationThreadReplyFooterText', () => {
  it('passes every active pull request to non-Slack footers', async () => {
    const linkedPrs = [
      { prNumber: 3, prUrl: 'https://github.com/roomote/app/pull/3' },
      { prNumber: 2, prUrl: 'https://github.com/roomote/api/pull/2' },
    ];
    resolveThreadReplyFooterContextMock.mockResolvedValue({
      linkedPrs,
      livePreviewUrl: null,
    });
    buildThreadReplyFooterTextMock.mockReturnValue('Footer');

    await buildCommunicationThreadReplyFooterText({
      provider: 'telegram',
      taskRun: {
        id: 42,
        taskId: 'task-1',
        payload: {},
      },
    });

    expect(buildThreadReplyFooterTextMock).toHaveBeenCalledWith(
      expect.objectContaining({ linkedPrs }),
    );
  });

  it('uses subtext for Discord footers', async () => {
    buildThreadReplyFooterTextMock.mockImplementation(({ formatFooterText }) =>
      formatFooterText('Footer'),
    );

    await expect(
      buildCommunicationThreadReplyFooterText({
        provider: 'discord',
        taskRun: {
          id: 42,
          taskId: 'task-1',
          payload: {},
        },
      }),
    ).resolves.toBe('-# Footer');
  });
});
