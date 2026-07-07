const {
  mockCreateRoomoteEnv,
  mockGetRuntimeBootstrapState,
  mockPostgres,
  mockDrizzle,
  firstClient,
  secondClient,
} = vi.hoisted(() => ({
  mockCreateRoomoteEnv: vi.fn(),
  mockGetRuntimeBootstrapState: vi.fn(),
  mockPostgres: vi.fn(),
  mockDrizzle: vi.fn(),
  firstClient: {
    end: vi.fn().mockResolvedValue(undefined),
  },
  secondClient: {
    end: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@roomote/env', () => ({
  createRoomoteEnv: (...args: unknown[]) => mockCreateRoomoteEnv(...args),
  getRuntimeBootstrapState: (...args: unknown[]) =>
    mockGetRuntimeBootstrapState(...args),
}));

vi.mock('postgres', () => ({
  default: (...args: unknown[]) => mockPostgres(...args),
}));

vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: (...args: unknown[]) => mockDrizzle(...args),
}));

function makeDbConfig(url: string) {
  return {
    DATABASE_URL: url,
    NODE_ENV: 'production',
  };
}

function makeProbeClient({ error }: { error?: Error }) {
  return Object.assign(
    vi.fn(async () => {
      if (error) {
        throw error;
      }

      return [{ '?column?': 1 }];
    }),
    {
      end: vi.fn().mockResolvedValue(undefined),
    },
  );
}

describe('assertSafeTestDatabaseUrl', () => {
  it('allows local databases with test names in test mode', async () => {
    const { assertSafeTestDatabaseUrl } = await import('../db');

    expect(() =>
      assertSafeTestDatabaseUrl(
        'postgres://postgres:password@localhost:5432/roomote_test',
        'test',
      ),
    ).not.toThrow();
    expect(() =>
      assertSafeTestDatabaseUrl(
        'postgres://postgres:password@127.0.0.1:5432/test',
        'test',
      ),
    ).not.toThrow();
  });

  it('rejects non-test database names in test mode', async () => {
    const { assertSafeTestDatabaseUrl } = await import('../db');

    expect(() =>
      assertSafeTestDatabaseUrl(
        'postgres://postgres:password@localhost:5432/roomote_development',
        'test',
      ),
    ).toThrow(
      'DATABASE_URL is not a test database (host=localhost, database=roomote_development)',
    );
  });

  it('rejects non-local hosts in test mode', async () => {
    const { assertSafeTestDatabaseUrl } = await import('../db');

    expect(() =>
      assertSafeTestDatabaseUrl(
        'postgres://postgres:password@db.example.com:5432/roomote_test',
        'test',
      ),
    ).toThrow(
      'DATABASE_URL is not a test database (host=db.example.com, database=roomote_test)',
    );
  });

  it('does not restrict database URLs outside test mode', async () => {
    const { assertSafeTestDatabaseUrl } = await import('../db');

    expect(() =>
      assertSafeTestDatabaseUrl(
        'postgres://postgres:password@db.example.com:5432/roomote_production',
        'development',
      ),
    ).not.toThrow();
  });
});

describe('db singleton proxy', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalNextRuntime = process.env.NEXT_RUNTIME;
  const originalNextPhase = process.env.NEXT_PHASE;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.DATABASE_URL;
    delete process.env.NEXT_RUNTIME;
    delete process.env.NEXT_PHASE;

    firstClient.end.mockResolvedValue(undefined);
    secondClient.end.mockResolvedValue(undefined);
    mockGetRuntimeBootstrapState.mockReturnValue({
      hasExplicitBootstrap: false,
    });
  });

  afterAll(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }

    if (originalNextRuntime === undefined) {
      delete process.env.NEXT_RUNTIME;
    } else {
      process.env.NEXT_RUNTIME = originalNextRuntime;
    }

    if (originalNextPhase === undefined) {
      delete process.env.NEXT_PHASE;
    } else {
      process.env.NEXT_PHASE = originalNextPhase;
    }
  });

  it('initializes lazily on first access and reuses the same instance', async () => {
    mockCreateRoomoteEnv.mockReturnValue({
      DATABASE_URL: 'postgres://user:secret@localhost/app',
      NODE_ENV: 'production',
    });
    mockPostgres.mockReturnValue(firstClient);
    mockDrizzle.mockReturnValue({ query: vi.fn() });

    const { db } = await import('../db');

    expect(mockCreateRoomoteEnv).not.toHaveBeenCalled();
    expect(mockPostgres).not.toHaveBeenCalled();

    void db.query;

    expect(mockCreateRoomoteEnv).toHaveBeenCalledTimes(1);
    expect(mockPostgres).toHaveBeenCalledTimes(1);

    void db.query;

    expect(mockCreateRoomoteEnv).toHaveBeenCalledTimes(1);
    expect(mockPostgres).toHaveBeenCalledTimes(1);
  });

  it('rehydrates the cached client and rebuilds from the current env', async () => {
    mockCreateRoomoteEnv
      .mockReturnValueOnce({
        DATABASE_URL: 'postgres://first:secret@localhost/app',
        NODE_ENV: 'production',
      })
      .mockReturnValueOnce({
        DATABASE_URL: 'postgres://second:secret@localhost/app',
        NODE_ENV: 'production',
      });
    mockPostgres
      .mockReturnValueOnce(firstClient)
      .mockReturnValueOnce(secondClient);
    mockDrizzle
      .mockReturnValueOnce({ query: vi.fn() })
      .mockReturnValueOnce({ query: vi.fn() });

    const { db, rehydrateDb } = await import('../db');

    void db.query;
    await rehydrateDb();
    void db.query;

    expect(firstClient.end).toHaveBeenCalledTimes(1);
    expect(secondClient.end).not.toHaveBeenCalled();
    expect(mockPostgres).toHaveBeenNthCalledWith(
      1,
      'postgres://first:secret@localhost/app',
      {
        prepare: false,
        max: 10,
      },
    );
    expect(mockPostgres).toHaveBeenNthCalledWith(
      2,
      'postgres://second:secret@localhost/app',
      {
        prepare: false,
        max: 10,
      },
    );
  });

  it('rejects non-test databases when NODE_ENV is test', async () => {
    mockCreateRoomoteEnv.mockReturnValue({
      DATABASE_URL: 'postgres://user:secret@example.com/app',
      NODE_ENV: 'test',
    });

    const { db } = await import('../db');

    expect(() => db.query).toThrow(
      'DATABASE_URL is not a test database (host=example.com, database=app)',
    );
    expect(mockPostgres).not.toHaveBeenCalled();
  });

  it('rejects an empty DATABASE_URL before creating a postgres client', async () => {
    mockCreateRoomoteEnv.mockReturnValue({
      DATABASE_URL: '',
      NODE_ENV: 'production',
    });

    const { db } = await import('../db');

    expect(() => db.query).toThrow('DATABASE_URL must be a non-empty string.');
    expect(mockPostgres).not.toHaveBeenCalled();
  });

  it('blocks db initialization before the web runtime bootstrap completes', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    mockCreateRoomoteEnv.mockReturnValue(
      makeDbConfig(
        'postgres://configured:secret@configured.example.com/app_db',
      ),
    );

    const { db } = await import('../db');

    expect(() => db.query).toThrow(
      /accessed before apps\/web finished bootstrapping dotenvx-backed runtime env/i,
    );
    expect(mockCreateRoomoteEnv).not.toHaveBeenCalled();
    expect(mockPostgres).not.toHaveBeenCalled();
  });

  it('allows db initialization after the web runtime bootstrap completes', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    mockGetRuntimeBootstrapState.mockReturnValue({
      hasExplicitBootstrap: true,
    });
    mockPostgres.mockReturnValue(firstClient);
    mockDrizzle.mockReturnValue({ query: vi.fn() });

    const { db, initializeDb } = await import('../db');

    await initializeDb(
      'postgres://configured:secret@configured.example.com/app_db',
    );
    void db.query;

    expect(mockCreateRoomoteEnv).not.toHaveBeenCalled();
    expect(mockPostgres).toHaveBeenCalledTimes(1);
  });

  it('blocks web-runtime db access after bootstrap until explicit db initialization runs', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    mockGetRuntimeBootstrapState.mockReturnValue({
      hasExplicitBootstrap: true,
    });
    mockCreateRoomoteEnv.mockReturnValue(
      makeDbConfig(
        'postgres://configured:secret@configured.example.com/app_db',
      ),
    );

    const { db } = await import('../db');

    expect(() => db.query).toThrow(
      /explicitly initialized the database singleton from the validated runtime env/i,
    );
    expect(mockCreateRoomoteEnv).not.toHaveBeenCalled();
    expect(mockPostgres).not.toHaveBeenCalled();
  });

  it('reports sanitized query diagnostics including the underlying postgres cause', async () => {
    process.env.DATABASE_URL =
      'postgres://runtime:secret@runtime.example.com/runtime_db';
    mockCreateRoomoteEnv.mockReturnValue(
      makeDbConfig(
        'postgres://configured:secret@configured.example.com/app_db?sslmode=require',
      ),
    );
    mockPostgres.mockReturnValue(firstClient);
    mockDrizzle.mockReturnValue({ query: vi.fn() });

    const { db, getDatabaseErrorDiagnostics } = await import('../db');

    void db.query;

    const cause = Object.assign(
      new Error('getaddrinfo ENOTFOUND configured.example.com'),
      {
        code: 'ENOTFOUND',
        errno: -3008,
        hostname: 'configured.example.com',
        syscall: 'getaddrinfo',
      },
    );
    const error = Object.assign(
      new Error('Failed query: select 1\nparams: $1'),
      {
        query: 'select 1',
        params: ['user_123'],
        cause,
      },
    );

    expect(getDatabaseErrorDiagnostics(error)).toEqual(
      expect.objectContaining({
        kind: 'drizzle_query_error',
        query: 'select 1',
        paramCount: 1,
        runtime: expect.objectContaining({
          clientInitialized: true,
          configuredUrl: expect.objectContaining({
            details: expect.objectContaining({
              hostname: 'configured.example.com',
              database: 'app_db',
              sslmode: 'require',
            }),
          }),
          processEnvUrl: expect.objectContaining({
            details: expect.objectContaining({
              hostname: 'runtime.example.com',
              database: 'runtime_db',
            }),
          }),
        }),
        cause: expect.objectContaining({
          code: 'ENOTFOUND',
          hostname: 'configured.example.com',
          syscall: 'getaddrinfo',
        }),
      }),
    );
  });

  it('probes the configured and runtime env database URLs independently', async () => {
    process.env.DATABASE_URL =
      'postgres://runtime:secret@runtime.example.com/runtime_db';
    mockCreateRoomoteEnv.mockReturnValue(
      makeDbConfig('postgres://configured:secret@127.0.0.1/app_db'),
    );

    const configuredProbeError = Object.assign(
      new Error('connect ECONNREFUSED'),
      {
        code: 'ECONNREFUSED',
        hostname: '127.0.0.1',
        port: 5432,
      },
    );
    const configuredProbeClient = makeProbeClient({
      error: configuredProbeError,
    });
    const runtimeProbeClient = makeProbeClient({});

    mockPostgres
      .mockReturnValueOnce(firstClient)
      .mockReturnValueOnce(configuredProbeClient)
      .mockReturnValueOnce(runtimeProbeClient);
    mockDrizzle.mockReturnValue({ query: vi.fn() });

    const { db, getDatabaseReachabilityDiagnostics } = await import('../db');

    void db.query;

    await expect(getDatabaseReachabilityDiagnostics()).resolves.toEqual({
      urlsMatch: false,
      configuredUrl: {
        status: 'unreachable',
        error: expect.objectContaining({
          code: 'ECONNREFUSED',
          hostname: '127.0.0.1',
          port: 5432,
        }),
      },
      processEnvUrl: {
        status: 'reachable',
        error: null,
      },
    });
  });
});

describe('dev client cache', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv('NODE_ENV', 'development');
    delete (globalThis as Record<string, unknown>).__roomoteDevPgClients;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete (globalThis as Record<string, unknown>).__roomoteDevPgClients;
  });

  it('reuses the cached pool across module re-evaluations in development', async () => {
    mockPostgres.mockReturnValue(firstClient);

    const first = await import('../db');
    await first.initializeDb('postgres://localhost:5432/dev');
    expect(mockPostgres).toHaveBeenCalledTimes(1);

    // Simulate a next dev HMR recompile: fresh module scope, same globalThis.
    vi.resetModules();
    const second = await import('../db');
    await second.initializeDb('postgres://localhost:5432/dev');

    expect(mockPostgres).toHaveBeenCalledTimes(1);
    expect(firstClient.end).not.toHaveBeenCalled();
  });

  it('ends cached pools on disconnect even after a re-evaluation', async () => {
    mockPostgres.mockReturnValue(firstClient);

    const first = await import('../db');
    await first.initializeDb('postgres://localhost:5432/dev');

    vi.resetModules();
    const second = await import('../db');
    await second.disconnect();

    expect(firstClient.end).toHaveBeenCalledTimes(1);
  });
});
