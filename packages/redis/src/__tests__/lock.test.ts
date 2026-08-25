import type { Redis } from 'ioredis';

import { acquireRedisLock, withRedisLock, withContention } from '../lock';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockRedis(overrides: Partial<Redis> = {}): Redis {
  return {
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    eval: vi.fn().mockResolvedValue(1),
    ...overrides,
  } as unknown as Redis;
}

// ---------------------------------------------------------------------------
// withRedisLock
// ---------------------------------------------------------------------------

describe('acquireRedisLock', () => {
  it('returns a release function when the lock is acquired', async () => {
    const redis = createMockRedis();

    const release = await acquireRedisLock('test-lock', { redis });

    expect(release).toEqual(expect.any(Function));
    expect(redis.set).toHaveBeenCalledWith(
      'test-lock',
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
      'EX',
      30,
      'NX',
    );
  });

  it('returns null when the lock is already held', async () => {
    const redis = createMockRedis({ set: vi.fn().mockResolvedValue(null) });

    const release = await acquireRedisLock('test-lock', { redis });

    expect(release).toBeNull();
  });

  it('releases the lock with a conditional delete', async () => {
    const redis = createMockRedis();

    const release = await acquireRedisLock('test-lock', { redis });

    await release?.();

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call'),
      1,
      'test-lock',
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
    );
  });

  it('renews the lock with a conditional expire', async () => {
    const redis = createMockRedis();

    const release = await acquireRedisLock('test-lock', {
      redis,
      ttlSeconds: 45,
    });

    const renewed = await release?.renew();

    expect(renewed).toBe(true);
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('expire'"),
      1,
      'test-lock',
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
      '45',
    );
  });
});

describe('withRedisLock', () => {
  it('acquires the lock and returns the callback value', async () => {
    const redis = createMockRedis();

    const result = await withRedisLock('test-lock', { redis }, async () => 42);

    expect(result).toEqual({ acquired: true, value: 42 });
    expect(redis.set).toHaveBeenCalledWith(
      'test-lock',
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
      'EX',
      30,
      'NX',
    );
  });

  it('uses a custom TTL when provided', async () => {
    const redis = createMockRedis();

    await withRedisLock(
      'test-lock',
      { ttlSeconds: 60, redis },
      async () => 'ok',
    );

    expect(redis.set).toHaveBeenCalledWith(
      'test-lock',
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
      'EX',
      60,
      'NX',
    );
  });

  it('returns { acquired: false } when the lock is already held', async () => {
    const redis = createMockRedis({ set: vi.fn().mockResolvedValue(null) });
    const fn = vi.fn();

    const result = await withRedisLock('test-lock', { redis }, fn);

    expect(result).toEqual({ acquired: false });
    expect(fn).not.toHaveBeenCalled();
  });

  it('releases the lock and re-throws when the callback throws', async () => {
    const redis = createMockRedis();
    const error = new Error('boom');

    await expect(
      withRedisLock('test-lock', { redis }, async () => {
        throw error;
      }),
    ).rejects.toThrow('boom');

    // Uses conditional Lua release (eval) instead of unconditional del
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call'),
      1,
      'test-lock',
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
    );
  });

  it('does NOT release the lock on success (lets TTL expire)', async () => {
    const redis = createMockRedis();

    await withRedisLock('test-lock', { redis }, async () => 'ok');

    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('swallows redis.eval errors during cleanup', async () => {
    const redis = createMockRedis({
      eval: vi.fn().mockRejectedValue(new Error('redis down')),
    });

    await expect(
      withRedisLock('test-lock', { redis }, async () => {
        throw new Error('callback error');
      }),
    ).rejects.toThrow('callback error');

    // Should not throw the redis.eval error
    expect(redis.eval).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// withContention
// ---------------------------------------------------------------------------

describe('withContention', () => {
  it('returns acquired result when lock is obtained', async () => {
    const redis = createMockRedis();

    const result = await withContention<number>('test-lock', {
      redis,
      onAcquired: async () => 99,
      onContended: async () => undefined,
    });

    expect(result).toEqual({ acquired: true, value: 99 });
  });

  it('renews an acquired lease while slow creation is still running', async () => {
    vi.useFakeTimers();
    const redis = createMockRedis();
    let finishCreation: (() => void) | undefined;
    const creation = new Promise<void>((resolve) => {
      finishCreation = resolve;
    });

    const resultPromise = withContention<number>('test-lock', {
      redis,
      ttlSeconds: 30,
      renewIntervalMs: 10_000,
      onAcquired: async () => {
        await creation;
        return 99;
      },
      onContended: async () => undefined,
    });

    await vi.advanceTimersByTimeAsync(31_000);

    expect(redis.eval).toHaveBeenCalledTimes(3);
    expect(redis.eval).toHaveBeenLastCalledWith(
      expect.stringContaining("redis.call('expire'"),
      1,
      'test-lock',
      expect.any(String),
      '30',
    );

    finishCreation?.();
    await expect(resultPromise).resolves.toEqual({
      acquired: true,
      value: 99,
    });
    vi.useRealTimers();
  });

  it('polls onContended when lock is held and returns first non-undefined value', async () => {
    const redis = createMockRedis({ set: vi.fn().mockResolvedValue(null) });
    let pollCount = 0;

    const result = await withContention<string>('test-lock', {
      redis,
      poll: { intervalMs: 10, maxAttempts: 5 },
      onAcquired: async () => 'should not run',
      onContended: async () => {
        pollCount++;
        return pollCount >= 3 ? 'found-it' : undefined;
      },
    });

    expect(result).toEqual({ acquired: false, value: 'found-it' });
    expect(pollCount).toBe(3);
  });

  it('returns undefined value when polling is exhausted', async () => {
    const redis = createMockRedis({ set: vi.fn().mockResolvedValue(null) });
    let pollCount = 0;

    const result = await withContention<number>('test-lock', {
      redis,
      poll: { intervalMs: 10, maxAttempts: 3 },
      onAcquired: async () => 1,
      onContended: async () => {
        pollCount++;
        return undefined;
      },
    });

    expect(result).toEqual({ acquired: false, value: undefined });
    expect(pollCount).toBe(3);
  });

  it('uses default poll settings when not specified', async () => {
    const redis = createMockRedis({ set: vi.fn().mockResolvedValue(null) });
    let pollCount = 0;

    // Use vi.useFakeTimers to avoid actually waiting 500ms * 10 attempts
    vi.useFakeTimers();

    const resultPromise = withContention<number>('test-lock', {
      redis,
      onAcquired: async () => 1,
      onContended: async () => {
        pollCount++;
        return pollCount >= 2 ? 42 : undefined;
      },
    });

    // Advance timers through the poll intervals (default 500ms)
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);

    const result = await resultPromise;

    expect(result).toEqual({ acquired: false, value: 42 });
    expect(pollCount).toBe(2);

    vi.useRealTimers();
  });

  it('propagates errors from onAcquired and releases the lock', async () => {
    const redis = createMockRedis();

    await expect(
      withContention('test-lock', {
        redis,
        onAcquired: async () => {
          throw new Error('create failed');
        },
        onContended: async () => undefined,
      }),
    ).rejects.toThrow('create failed');

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call'),
      1,
      'test-lock',
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
    );
  });

  it('does not call onContended when lock is acquired', async () => {
    const redis = createMockRedis();
    const onContended = vi.fn();

    await withContention('test-lock', {
      redis,
      onAcquired: async () => 'done',
      onContended,
    });

    expect(onContended).not.toHaveBeenCalled();
  });

  it('handles onContended throwing by propagating the error', async () => {
    const redis = createMockRedis({ set: vi.fn().mockResolvedValue(null) });

    await expect(
      withContention('test-lock', {
        redis,
        poll: { intervalMs: 10, maxAttempts: 3 },
        onAcquired: async () => 'ok',
        onContended: async () => {
          throw new Error('poll query failed');
        },
      }),
    ).rejects.toThrow('poll query failed');
  });
});
