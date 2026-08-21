const { envMock, redisConstructorMock, redisOnMock } = vi.hoisted(() => ({
  envMock: {
    REDIS_URL: 'redis://from-env-object:6379',
  },
  redisConstructorMock: vi.fn(),
  redisOnMock: vi.fn(),
}));

vi.mock('@roomote/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@roomote/env')>();

  return {
    ...actual,
    Env: envMock,
  };
});

vi.mock('ioredis', () => ({
  Redis: class MockRedis {
    constructor(...args: unknown[]) {
      redisConstructorMock(...args);
    }

    on(...args: unknown[]) {
      redisOnMock(...args);
      return this;
    }
  },
}));

describe('getRedis', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
    delete process.env.REDIS_URL;
    envMock.REDIS_URL = 'redis://from-env-object:6379';
  });

  it('prefers the live process env over the snapshotted Env value', async () => {
    process.env.REDIS_URL = 'redis://from-process-env:6379';

    const { getRedis } = await import('../index');

    getRedis();

    expect(redisConstructorMock).toHaveBeenCalledWith(
      'redis://from-process-env:6379',
      expect.objectContaining({
        maxRetriesPerRequest: 3,
        connectTimeout: 5000,
        retryStrategy: expect.any(Function),
      }),
    );
  });

  it('caps reconnect delays while allowing the client to recover', async () => {
    const { getRedis } = await import('../index');

    getRedis();

    const options = redisConstructorMock.mock.calls[0]?.[1] as {
      retryStrategy: (attempt: number) => number;
    };
    expect(options.retryStrategy(1)).toBe(50);
    expect(options.retryStrategy(100)).toBe(2_000);
  });

  it('provides a separate BullMQ-compatible blocking client', async () => {
    const { getBullMqRedis, getRedis } = await import('../index');

    const sharedClient = getRedis();
    const bullMqClient = getBullMqRedis();

    expect(bullMqClient).not.toBe(sharedClient);
    expect(redisConstructorMock).toHaveBeenNthCalledWith(
      2,
      'redis://from-env-object:6379',
      expect.objectContaining({ maxRetriesPerRequest: null }),
    );
  });

  it('rate-limits connection errors and summarizes recovery', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T03:41:59.000Z'));
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const consoleInfoSpy = vi
      .spyOn(console, 'info')
      .mockImplementation(() => undefined);
    const { getRedis } = await import('../index');

    getRedis();

    const handlers = Object.fromEntries(redisOnMock.mock.calls) as Record<
      string,
      (...args: unknown[]) => void
    >;
    const dnsError = Object.assign(
      new Error('getaddrinfo ENOTFOUND redis.internal'),
      { code: 'ENOTFOUND' },
    );

    handlers.error?.(dnsError);
    handlers.error?.(dnsError);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenLastCalledWith(
      '[redis] connection degraded; dependent operations may fail',
      {
        code: 'ENOTFOUND',
        message: 'getaddrinfo ENOTFOUND redis.internal',
        suppressedErrors: 0,
      },
    );

    vi.advanceTimersByTime(30_000);
    handlers.error?.(dnsError);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
    expect(consoleErrorSpy).toHaveBeenLastCalledWith(
      '[redis] connection degraded; dependent operations may fail',
      {
        code: 'ENOTFOUND',
        message: 'getaddrinfo ENOTFOUND redis.internal',
        suppressedErrors: 1,
      },
    );

    vi.advanceTimersByTime(5_000);
    handlers.ready?.();
    expect(consoleInfoSpy).toHaveBeenCalledWith('[redis] connection restored', {
      outageDurationMs: 35_000,
      totalErrors: 3,
      suppressedErrors: 0,
    });

    consoleErrorSpy.mockRestore();
    consoleInfoSpy.mockRestore();
  });

  it('throws when REDIS_URL is unavailable', async () => {
    envMock.REDIS_URL = '';

    const { getRedis } = await import('../index');

    expect(() => getRedis()).toThrow('REDIS_URL is not configured');
    expect(redisConstructorMock).not.toHaveBeenCalled();
  });
});
