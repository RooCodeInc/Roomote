const { mockDotenvxConfig, mockDotenvxGet, mockExistsSync } = vi.hoisted(
  () => ({
    mockDotenvxConfig: vi.fn(),
    mockDotenvxGet: vi.fn(),
    mockExistsSync: vi.fn(),
  }),
);

vi.mock('@dotenvx/dotenvx', () => ({
  get: (...args: unknown[]) => mockDotenvxGet(...args),
  config: (...args: unknown[]) => mockDotenvxConfig(...args),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const existsSync = (...args: unknown[]) => mockExistsSync(...args);

  return {
    ...actual,
    default: { ...actual, existsSync },
    existsSync,
  };
});

describe('web server Env wrapper', () => {
  const defaultTestDatabaseUrl =
    'postgres://postgres:password@localhost:15432/roomote_test';
  const webRuntimeBootstrapStateKey = Symbol.for(
    'roomote.runtimeBootstrapState',
  );
  const originalAppEnv = process.env.APP_ENV;
  const originalNextRuntime = process.env.NEXT_RUNTIME;
  const originalNextPhase = process.env.NEXT_PHASE;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    Reflect.deleteProperty(globalThis, webRuntimeBootstrapStateKey);
    delete process.env.APP_ENV;
    delete process.env.NEXT_RUNTIME;
    delete process.env.NEXT_PHASE;

    mockDotenvxConfig.mockReturnValue({ parsed: {} });
    mockExistsSync.mockReturnValue(true);

    // By default, pass through to process.env (simulates dotenvx after config)
    mockDotenvxGet.mockImplementation((key: string) => process.env[key]);
  });

  const expectedDatabaseUrl = () =>
    process.env.DATABASE_URL ?? defaultTestDatabaseUrl;

  afterAll(() => {
    if (originalAppEnv === undefined) {
      delete process.env.APP_ENV;
    } else {
      process.env.APP_ENV = originalAppEnv;
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

  it('treats missing optional dotenvx keys as undefined and preserves schema defaults', async () => {
    const previousSkipEnvValidation = process.env.SKIP_ENV_VALIDATION;
    delete process.env.SKIP_ENV_VALIDATION;

    mockDotenvxGet.mockImplementation((key: string) => {
      if (
        key === 'ARTIFACT_SIGNING_KEY_PREVIOUS' ||
        key === 'PREVIEW_TOKEN_TTL_SECONDS'
      ) {
        return undefined;
      }
      return process.env[key];
    });

    try {
      const { Env } = await import('../env');

      expect(Env.ARTIFACT_SIGNING_KEY_PREVIOUS).toBeUndefined();
      expect(Env.PREVIEW_TOKEN_TTL_SECONDS).toBe(3600);
    } finally {
      if (previousSkipEnvValidation === undefined) {
        delete process.env.SKIP_ENV_VALIDATION;
      } else {
        process.env.SKIP_ENV_VALIDATION = previousSkipEnvValidation;
      }
    }
  });

  it('passes the ignore options to suppress dotenvx missing-value warnings', async () => {
    const { Env } = await import('../env');

    // Access a required key to trigger at least one dotenvx.get call
    void Env.DATABASE_URL;

    // Every call should include the ignore option
    for (const call of mockDotenvxGet.mock.calls) {
      expect(call[1]).toEqual({
        ignore: ['MISSING_ENV_FILE', 'MISSING_KEY'],
      });
    }
  });

  it('bootstraps dotenvx loading before the first Env access outside Next runtime', async () => {
    let loaded = false;

    mockDotenvxConfig.mockImplementation(() => {
      loaded = true;
      return { parsed: {} };
    });

    mockDotenvxGet.mockImplementation((key: string) => {
      if (!loaded && key === 'DATABASE_URL') {
        return undefined;
      }

      return process.env[key];
    });

    const { Env } = await import('../env');

    expect(Env.DATABASE_URL).toBe(expectedDatabaseUrl());
    expect(mockDotenvxConfig).toHaveBeenCalledTimes(1);
  });

  it('throws on lazy Env access before explicit bootstrap in Next nodejs runtime', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';

    const { Env } = await import('../env');

    expect(() => Env.DATABASE_URL).toThrow(
      /accessed before instrumentation register\(\) completed/i,
    );
    expect(mockDotenvxConfig).not.toHaveBeenCalled();
  });

  it('reports runtime diagnostics before explicit bootstrap', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';

    const { getWebRuntimeEnvDiagnostics } = await import('../env');

    expect(getWebRuntimeEnvDiagnostics()).toEqual({
      nextRuntime: 'nodejs',
      appEnv: 'development',
      bootstrapCompleted: false,
      isBuildPhase: false,
      nextPhase: null,
    });
  });

  it('defaults dotenvx bootstrap to the local env file when APP_ENV is unset', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    delete process.env.APP_ENV;
    delete process.env.R_APP_ENV;

    const { initializeWebRuntimeEnv } = await import('../env');

    initializeWebRuntimeEnv();

    expect(mockDotenvxConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        path: ['../../.env.local'],
      }),
    );
  });

  it('allows lazy Env access during the Next production build phase', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    process.env.NEXT_PHASE = 'phase-production-build';

    const { Env } = await import('../env');

    expect(Env.DATABASE_URL).toBe(expectedDatabaseUrl());
    expect(mockDotenvxConfig).toHaveBeenCalledTimes(1);
  });

  it('fails fast when Next.js tries to run the web env bootstrap on edge', async () => {
    process.env.NEXT_RUNTIME = 'edge';

    const { initializeWebRuntimeEnv } = await import('../env');

    expect(() => initializeWebRuntimeEnv()).toThrow(
      /does not support the Next\.js Edge runtime/i,
    );
    expect(mockDotenvxConfig).not.toHaveBeenCalled();
  });

  it('does not require hosted dotenvx runtime files for nodejs', async () => {
    const previousSkipEnvValidation = process.env.SKIP_ENV_VALIDATION;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.NEXT_RUNTIME = 'nodejs';
    process.env.APP_ENV = 'production';
    process.env.SKIP_ENV_VALIDATION = 'true';
    process.env.DATABASE_URL = 'postgres://compose:secret@postgres/roomote';
    mockDotenvxConfig.mockReturnValue({
      parsed: {},
      error: new Error('missing .env.local'),
    });

    try {
      const { initializeWebRuntimeEnv } = await import('../env');

      expect(() => initializeWebRuntimeEnv()).not.toThrow();
      expect(mockDotenvxConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          path: ['../../.env.local'],
          strict: false,
        }),
      );
      expect(mockDotenvxGet).not.toHaveBeenCalled();
    } finally {
      if (previousDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
      if (previousSkipEnvValidation === undefined) {
        delete process.env.SKIP_ENV_VALIDATION;
      } else {
        process.env.SKIP_ENV_VALIDATION = previousSkipEnvValidation;
      }
    }
  });

  it('skips dotenvx entirely when no runtime env files exist on disk', async () => {
    const previousSkipEnvValidation = process.env.SKIP_ENV_VALIDATION;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.NEXT_RUNTIME = 'nodejs';
    process.env.APP_ENV = 'production';
    process.env.SKIP_ENV_VALIDATION = 'true';
    process.env.DATABASE_URL = 'postgres://compose:secret@postgres/roomote';
    mockExistsSync.mockReturnValue(false);

    try {
      const { Env, initializeWebRuntimeEnv } = await import('../env');

      initializeWebRuntimeEnv();

      expect(Env.DATABASE_URL).toBe(process.env.DATABASE_URL);
      expect(mockDotenvxConfig).not.toHaveBeenCalled();
      expect(mockDotenvxGet).not.toHaveBeenCalled();
    } finally {
      if (previousDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
      if (previousSkipEnvValidation === undefined) {
        delete process.env.SKIP_ENV_VALIDATION;
      } else {
        process.env.SKIP_ENV_VALIDATION = previousSkipEnvValidation;
      }
    }
  });

  it('allows Env reads after explicit bootstrap in Next nodejs runtime', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';

    const { Env, initializeWebRuntimeEnv } = await import('../env');

    initializeWebRuntimeEnv();

    expect(Env.DATABASE_URL).toBe(expectedDatabaseUrl());
    expect(mockDotenvxConfig).toHaveBeenCalledTimes(1);
  });

  it('reports runtime diagnostics after explicit bootstrap', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';

    const { getWebRuntimeEnvDiagnostics, initializeWebRuntimeEnv } =
      await import('../env');

    initializeWebRuntimeEnv();

    expect(getWebRuntimeEnvDiagnostics()).toEqual({
      nextRuntime: 'nodejs',
      appEnv: 'development',
      bootstrapCompleted: true,
      isBuildPhase: false,
      nextPhase: null,
    });
  });

  it('preserves explicit bootstrap across module reloads in the same process', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';

    const firstImport = await import('../env');

    firstImport.initializeWebRuntimeEnv();

    vi.resetModules();

    const secondImport = await import('../env');

    expect(secondImport.Env.DATABASE_URL).toBe(expectedDatabaseUrl());
    expect(mockDotenvxConfig).toHaveBeenCalledTimes(2);
  });

  it('uses the local preview domain default when PREVIEW_DOMAINS is missing outside production', async () => {
    const previousSkipEnvValidation = process.env.SKIP_ENV_VALIDATION;

    delete process.env.SKIP_ENV_VALIDATION;

    mockDotenvxGet.mockImplementation((key: string) => {
      if (key === 'PREVIEW_DOMAINS') {
        return undefined;
      }

      return process.env[key];
    });

    try {
      const { Env, rehydrateWebEnv } = await import('../env');

      rehydrateWebEnv();

      expect(Env.PREVIEW_DOMAINS).toBe(
        'localhost,127.0.0.1,roomotepreview.localhost',
      );
    } finally {
      if (previousSkipEnvValidation === undefined) {
        delete process.env.SKIP_ENV_VALIDATION;
      } else {
        process.env.SKIP_ENV_VALIDATION = previousSkipEnvValidation;
      }
    }
  });

  it('can rehydrate after dotenvx values become available', async () => {
    let loaded = false;

    mockDotenvxGet.mockImplementation((key: string) => {
      if (!loaded && key === 'DATABASE_URL') {
        return undefined;
      }

      return process.env[key];
    });

    const { Env, rehydrateWebEnv } = await import('../env');

    loaded = true;
    rehydrateWebEnv();

    expect(Env.DATABASE_URL).toBe(expectedDatabaseUrl());
  });
});
