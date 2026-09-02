import { describe, expect, it } from 'vitest';

import { resolveBullMqHealth } from './health';

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
