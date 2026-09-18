import { describe, expect, it, vi } from 'vitest';

import { readBullMqQueueHealth, resolveBullMqHealth } from './health';

describe('resolveBullMqHealth', () => {
  it('reports healthy only when Redis is ready', () => {
    expect(resolveBullMqHealth('ready')).toEqual({
      status: 'ok',
      httpStatus: 200,
    });
  });

  it.each([undefined, 'connecting', 'reconnecting', 'end'])(
    'reports %s Redis as unavailable',
    (redisStatus) => {
      expect(resolveBullMqHealth(redisStatus)).toEqual({
        status: 'error',
        httpStatus: 503,
      });
    },
  );
});

describe('readBullMqQueueHealth', () => {
  it.each([undefined, 'connecting', 'reconnecting', 'end'])(
    'does not read queue counts when Redis is %s',
    async (redisStatus) => {
      const readQueueCounts = vi.fn();

      await expect(
        readBullMqQueueHealth(redisStatus, readQueueCounts),
      ).resolves.toEqual({
        status: 'error',
        httpStatus: 503,
        queueCounts: null,
      });
      expect(readQueueCounts).not.toHaveBeenCalled();
    },
  );

  it('reads queue counts when Redis is ready', async () => {
    const queueCounts = { waiting: 1 };
    const readQueueCounts = vi.fn().mockResolvedValue(queueCounts);

    await expect(
      readBullMqQueueHealth('ready', readQueueCounts),
    ).resolves.toEqual({
      status: 'ok',
      httpStatus: 200,
      queueCounts,
    });
    expect(readQueueCounts).toHaveBeenCalledOnce();
  });
});
