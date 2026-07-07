import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getMock, setMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  setMock: vi.fn(),
}));

vi.mock('@roomote/redis', () => ({
  getRedis: vi.fn(() => ({
    get: getMock,
    set: setMock,
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
