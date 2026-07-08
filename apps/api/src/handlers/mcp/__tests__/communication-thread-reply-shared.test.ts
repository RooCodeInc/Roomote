import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getThreadReplyFooterRecordMock,
  setThreadReplyFooterRecordMock,
  withThreadReplyFooterLockMock,
} = vi.hoisted(() => ({
  getThreadReplyFooterRecordMock: vi.fn(),
  setThreadReplyFooterRecordMock: vi.fn(),
  withThreadReplyFooterLockMock: vi.fn(),
}));

vi.mock('@roomote/communication', async () => {
  const actual = await vi.importActual<typeof import('@roomote/communication')>(
    '@roomote/communication',
  );

  return {
    ...actual,
    getThreadReplyFooterRecord: getThreadReplyFooterRecordMock,
    setThreadReplyFooterRecord: setThreadReplyFooterRecordMock,
  };
});

vi.mock('../chat-reply-helpers', () => ({
  buildThreadReplyImageBlocks: vi.fn(),
  errorResponseForThreadReplyImageError: vi.fn(),
  withThreadReplyFooterLock: withThreadReplyFooterLockMock,
}));

import { deliverManagedThreadReplyFooter } from '../communication-thread-reply-shared';

describe('deliverManagedThreadReplyFooter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withThreadReplyFooterLockMock.mockImplementation(async ({ fn }) => fn());
    setThreadReplyFooterRecordMock.mockResolvedValue(undefined);
  });

  it('clears the prior footer message and persists the latest footer record', async () => {
    getThreadReplyFooterRecordMock.mockResolvedValue({
      messageId: 'old-message',
      textWithoutFooter: 'Previous reply',
      images: [
        {
          url: 'https://app.example.com/api/artifacts/art-1/raw?sig=signed',
          altText: 'screenshot.png',
          contentType: 'image/png',
        },
      ],
    });
    const clearPreviousFooter = vi.fn().mockResolvedValue(undefined);

    const reply = await deliverManagedThreadReplyFooter({
      provider: 'teams',
      providerLabel: 'Teams',
      channelId: 'channel-1',
      footerStateThreadId: 'thread-1',
      lockKey: 'lock-1',
      cloudJobId: 42,
      logContext: 'testContext',
      postReplyWithFooter: async () => ({
        messageId: 'new-message',
        textWithoutFooter: 'Latest reply',
        images: [
          {
            url: 'https://app.example.com/api/artifacts/art-2/raw?sig=signed',
            altText: 'next.png',
            contentType: 'image/png',
          },
        ],
      }),
      clearPreviousFooter,
    });

    expect(withThreadReplyFooterLockMock).toHaveBeenCalledWith({
      lockKey: 'lock-1',
      fn: expect.any(Function),
    });
    expect(getThreadReplyFooterRecordMock).toHaveBeenCalledWith(
      'teams',
      'channel-1',
      'thread-1',
    );
    expect(clearPreviousFooter).toHaveBeenCalledWith({
      messageId: 'old-message',
      textWithoutFooter: 'Previous reply',
      images: [
        {
          url: 'https://app.example.com/api/artifacts/art-1/raw?sig=signed',
          altText: 'screenshot.png',
          contentType: 'image/png',
        },
      ],
    });
    expect(setThreadReplyFooterRecordMock).toHaveBeenCalledWith(
      'teams',
      'channel-1',
      'thread-1',
      {
        messageId: 'new-message',
        textWithoutFooter: 'Latest reply',
        images: [
          {
            url: 'https://app.example.com/api/artifacts/art-2/raw?sig=signed',
            altText: 'next.png',
            contentType: 'image/png',
          },
        ],
      },
    );
    expect(reply).toEqual({
      messageId: 'new-message',
      textWithoutFooter: 'Latest reply',
      images: [
        {
          url: 'https://app.example.com/api/artifacts/art-2/raw?sig=signed',
          altText: 'next.png',
          contentType: 'image/png',
        },
      ],
    });
  });

  it('skips clearing when the latest footer reuses the same message id', async () => {
    getThreadReplyFooterRecordMock.mockResolvedValue({
      messageId: 'same-message',
      textWithoutFooter: 'Previous reply',
    });
    const clearPreviousFooter = vi.fn().mockResolvedValue(undefined);

    await deliverManagedThreadReplyFooter({
      provider: 'telegram',
      providerLabel: 'Telegram',
      channelId: 'channel-1',
      footerStateThreadId: 'thread-1',
      lockKey: 'lock-1',
      cloudJobId: 42,
      logContext: 'testContext',
      postReplyWithFooter: async () => ({
        messageId: 'same-message',
        textWithoutFooter: '',
      }),
      clearPreviousFooter,
    });

    expect(clearPreviousFooter).not.toHaveBeenCalled();
    expect(setThreadReplyFooterRecordMock).toHaveBeenCalledWith(
      'telegram',
      'channel-1',
      'thread-1',
      {
        messageId: 'same-message',
        textWithoutFooter: '',
      },
    );
  });
});
