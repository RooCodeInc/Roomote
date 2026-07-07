const { envMock, redisConstructorMock } = vi.hoisted(() => ({
  envMock: {
    REDIS_URL: 'redis://from-env-object:6379',
  },
  redisConstructorMock: vi.fn(),
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
  },
}));

describe('getRedis', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.REDIS_URL;
    envMock.REDIS_URL = 'redis://from-env-object:6379';
  });

  it('prefers the live process env over the snapshotted Env value', async () => {
    process.env.REDIS_URL = 'redis://from-process-env:6379';

    const { getRedis } = await import('../index');

    getRedis();

    expect(redisConstructorMock).toHaveBeenCalledWith(
      'redis://from-process-env:6379',
      {
        maxRetriesPerRequest: null,
        connectTimeout: 5000,
      },
    );
  });

  it('throws when REDIS_URL is unavailable', async () => {
    envMock.REDIS_URL = '';

    const { getRedis } = await import('../index');

    expect(() => getRedis()).toThrow('REDIS_URL is not configured');
    expect(redisConstructorMock).not.toHaveBeenCalled();
  });
});
