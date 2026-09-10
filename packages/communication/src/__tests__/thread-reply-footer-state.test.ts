import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getMock, setMock, evalMock, scheduleMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  setMock: vi.fn(),
  evalMock: vi.fn(),
  scheduleMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../thread-footer-refresh', () => ({
  scheduleThreadFooterRefresh: scheduleMock,
}));

vi.mock('@roomote/redis', () => ({
  getRedis: vi.fn(() => ({
    get: getMock,
    set: setMock,
    eval: evalMock,
  })),
}));

import {
  getThreadReplyFooterRecord,
  setThreadReplyFooterRecord,
} from '../thread-reply-footer-state';

describe('thread reply footer state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMock.mockResolvedValue(null);
    setMock.mockResolvedValue('OK');
    evalMock.mockResolvedValue(1);
  });

  it.each([false, true])(
    'atomically checks ownership with keepTtl=%s',
    async (keepTtl) => {
      const record = {
        messageId: 'activity-2',
        textWithoutFooter: 'reply',
        refresh: { footerText: 'idle', channelId: 'channel' },
      };
      const lock = { key: 'lock', ownerId: 'owner' };
      await expect(
        setThreadReplyFooterRecord('teams', 'channel', 'thread', record, {
          keepTtl,
          lock,
        }),
      ).resolves.toBe(true);
      expect(evalMock).toHaveBeenCalledWith(
        expect.stringContaining("redis.call('get', KEYS[1]) ~= ARGV[1]"),
        2,
        lock.key,
        'teams:thread_reply_footer:channel:thread',
        lock.ownerId,
        JSON.stringify(record),
        keepTtl ? 'keepTtl' : 30 * 24 * 60 * 60,
      );
      expect(setMock).not.toHaveBeenCalled();
      expect(scheduleMock).toHaveBeenCalledTimes(keepTtl ? 0 : 1);
      scheduleMock.mockClear();
      evalMock.mockResolvedValueOnce(0);
      await expect(
        setThreadReplyFooterRecord('teams', 'channel', 'thread', record, {
          keepTtl,
          lock,
        }),
      ).resolves.toBe(false);
      expect(scheduleMock).not.toHaveBeenCalled();
    },
  );

  it('reports a keepTtl write that found no record to update', async () => {
    const record = { messageId: 'activity-2', textWithoutFooter: 'reply' };
    expect(
      await setThreadReplyFooterRecord('teams', 'channel', 'thread', record, {
        keepTtl: true,
        lock: { key: 'lock', ownerId: 'owner' },
      }),
    ).toBe(true);
    expect(evalMock.mock.calls[0]![0]).toContain(
      "if not redis.call('set', KEYS[2], ARGV[2], 'KEEPTTL', 'XX') then return 0 end",
    );
    setMock.mockResolvedValueOnce(null);
    expect(
      await setThreadReplyFooterRecord('teams', 'channel', 'thread', record, {
        keepTtl: true,
      }),
    ).toBe(false);
    expect(setMock).toHaveBeenCalledWith(
      'teams:thread_reply_footer:channel:thread',
      JSON.stringify(record),
      'KEEPTTL',
      'XX',
    );
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it('stores footer records under a provider-scoped key with a TTL', async () => {
    await setThreadReplyFooterRecord('teams', '19:conversation', 'thread-1', {
      messageId: 'activity-2',
      textWithoutFooter: 'the bare reply text',
    });

    expect(setMock).toHaveBeenCalledWith(
      'teams:thread_reply_footer:19:conversation:thread-1',
      JSON.stringify({
        messageId: 'activity-2',
        textWithoutFooter: 'the bare reply text',
      }),
      'EX',
      30 * 24 * 60 * 60,
    );
  });

  it('reads back a stored footer record', async () => {
    getMock.mockResolvedValue(
      JSON.stringify({
        messageId: 'activity-2',
        textWithoutFooter: 'the bare reply text',
      }),
    );

    await expect(
      getThreadReplyFooterRecord('teams', '19:conversation', 'thread-1'),
    ).resolves.toEqual({
      messageId: 'activity-2',
      textWithoutFooter: 'the bare reply text',
    });

    expect(getMock).toHaveBeenCalledWith(
      'teams:thread_reply_footer:19:conversation:thread-1',
    );
  });

  it('reads back footer images used to re-attach content on footer clear', async () => {
    getMock.mockResolvedValue(
      JSON.stringify({
        messageId: 'activity-2',
        textWithoutFooter: 'the bare reply text',
        images: [
          {
            url: 'https://app.example.com/api/artifacts/art-1/raw?sig=signed',
            altText: 'screenshot.png',
            contentType: 'image/png',
          },
        ],
      }),
    );

    await expect(
      getThreadReplyFooterRecord('teams', '19:conversation', 'thread-1'),
    ).resolves.toEqual({
      messageId: 'activity-2',
      textWithoutFooter: 'the bare reply text',
      images: [
        {
          url: 'https://app.example.com/api/artifacts/art-1/raw?sig=signed',
          altText: 'screenshot.png',
          contentType: 'image/png',
        },
      ],
    });
  });

  it('returns null for missing or malformed records', async () => {
    await expect(
      getThreadReplyFooterRecord('teams', '19:conversation', 'thread-1'),
    ).resolves.toBeNull();

    getMock.mockResolvedValue('not-json');
    await expect(
      getThreadReplyFooterRecord('teams', '19:conversation', 'thread-1'),
    ).resolves.toBeNull();

    getMock.mockResolvedValue(JSON.stringify({ messageId: '' }));
    await expect(
      getThreadReplyFooterRecord('teams', '19:conversation', 'thread-1'),
    ).resolves.toBeNull();
  });
});
