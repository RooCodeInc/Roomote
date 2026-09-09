import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  buildThreadReplyFooterTextMock,
  getThreadReplyFooterRecordMock,
  resolveThreadReplyFooterContextMock,
  setThreadReplyFooterRecordMock,
  withThreadReplyFooterLockMock,
} = vi.hoisted(() => ({
  buildThreadReplyFooterTextMock: vi.fn(),
  getThreadReplyFooterRecordMock: vi.fn(),
  resolveThreadReplyFooterContextMock: vi.fn(),
  setThreadReplyFooterRecordMock: vi.fn(),
  withThreadReplyFooterLockMock: vi.fn(),
}));

vi.mock('@roomote/communication', async () => {
  const actual = await vi.importActual<typeof import('@roomote/communication')>(
    '@roomote/communication',
  );

  return {
    ...actual,
    buildThreadReplyFooterText: buildThreadReplyFooterTextMock,
    getThreadReplyFooterRecord: getThreadReplyFooterRecordMock,
    resolveThreadReplyFooterContext: resolveThreadReplyFooterContextMock,
    setThreadReplyFooterRecord: setThreadReplyFooterRecordMock,
  };
});

vi.mock('../chat-reply-helpers', () => ({
  buildThreadReplyImageBlocks: vi.fn(),
  errorResponseForThreadReplyImageError: vi.fn(),
  withThreadReplyFooterLock: withThreadReplyFooterLockMock,
}));

vi.mock('@roomote/env', () => ({
  Env: { R_APP_URL: 'https://app.example.com' },
}));

import {
  buildCommunicationThreadReplyFooterText,
  deliverManagedThreadReplyFooter,
} from '../communication-thread-reply-shared';

describe('deliverManagedThreadReplyFooter', () => {
  it('rejects an initial write when the lease changes after the final check', async () => {
    const lock = { key: 'lock', ownerId: 'original-owner' };
    const original = { messageId: 'original', textWithoutFooter: 'Old' };
    const competitor = { messageId: 'competitor', textWithoutFooter: 'B' };
    const posted = { messageId: 'orphan', textWithoutFooter: 'A' };
    let current = original;
    let owner = lock.ownerId;
    const assertLock = vi.fn(async () => {
      expect(owner).toBe(lock.ownerId);
      if (assertLock.mock.calls.length === 2) {
        owner = 'competitor-owner';
        current = competitor;
      }
    });
    withThreadReplyFooterLockMock.mockImplementation(async ({ fn }) =>
      fn(assertLock, lock),
    );
    getThreadReplyFooterRecordMock.mockImplementation(async () => current);
    setThreadReplyFooterRecordMock.mockImplementation(
      async (_provider, _channel, _thread, record, options) => {
        if (options?.lock && options.lock.ownerId !== owner) return false;
        current = record;
        return true;
      },
    );
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      deliverManagedThreadReplyFooter({
        provider: 'teams',
        providerLabel: 'Teams',
        channelId: 'C',
        footerStateThreadId: 'T',
        lockKey: 'lock',
        runId: 1,
        logContext: 'test',
        postReplyWithFooter: async () => posted,
        clearPreviousFooter: cleanup,
      }),
    ).resolves.toEqual(posted);
    expect(current).toEqual(competitor);
    expect(setThreadReplyFooterRecordMock).toHaveBeenCalledExactlyOnceWith(
      'teams',
      'C',
      'T',
      posted,
      { lock },
    );
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(posted);
    expect(owner).toBe('competitor-owner');
    warning.mockRestore();
  });
  it('a lease lost after posting leaves the competitor pointer untouched and cleans only the new reply', async () => {
    let owned = true;
    const competitor = { messageId: 'competitor', textWithoutFooter: 'B' };
    const original = { messageId: 'original', textWithoutFooter: 'Old' };
    getThreadReplyFooterRecordMock.mockResolvedValue(original);
    withThreadReplyFooterLockMock.mockImplementation(async ({ fn }) =>
      fn(async () => {
        if (!owned) throw new Error('lease lost');
      }),
    );
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await deliverManagedThreadReplyFooter({
      provider: 'teams',
      providerLabel: 'Teams',
      channelId: 'C',
      footerStateThreadId: 'T',
      lockKey: 'lock',
      runId: 1,
      logContext: 'test',
      postReplyWithFooter: async () => {
        owned = false;
        getThreadReplyFooterRecordMock.mockResolvedValue(competitor);
        return { messageId: 'orphan', textWithoutFooter: 'A' };
      },
      clearPreviousFooter: cleanup,
    });
    expect(result.messageId).toBe('orphan');
    expect(setThreadReplyFooterRecordMock).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledWith({
      messageId: 'orphan',
      textWithoutFooter: 'A',
    });
    warning.mockRestore();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    withThreadReplyFooterLockMock.mockImplementation(async ({ fn, lockKey }) =>
      fn(async () => {}, { key: lockKey, ownerId: 'owner' }),
    );
    setThreadReplyFooterRecordMock.mockResolvedValue(true);
    resolveThreadReplyFooterContextMock.mockResolvedValue({
      linkedPrs: [],
      livePreviewUrl: null,
    });
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
      runId: 42,
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
      { lock: { key: 'lock-1', ownerId: 'owner' } },
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
      runId: 42,
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
      { lock: { key: 'lock-1', ownerId: 'owner' } },
    );
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
