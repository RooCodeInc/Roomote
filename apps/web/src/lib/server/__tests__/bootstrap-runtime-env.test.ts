const {
  assertSecureWebBootMock,
  bootstrapGeneratedAuthKeypairsMock,
  configureAuthClientEnvMock,
  initializeDbMock,
  initializeWebRuntimeEnvMock,
  installWebSecretProviderMock,
  rehydrateWebEnvMock,
} = vi.hoisted(() => ({
  assertSecureWebBootMock: vi.fn(),
  bootstrapGeneratedAuthKeypairsMock: vi.fn(),
  configureAuthClientEnvMock: vi.fn(),
  initializeDbMock: vi.fn(),
  initializeWebRuntimeEnvMock: vi.fn(),
  installWebSecretProviderMock: vi.fn(),
  rehydrateWebEnvMock: vi.fn(),
}));

vi.mock('@roomote/auth/client', () => ({
  configureAuthClientEnv: configureAuthClientEnvMock,
}));

vi.mock('@roomote/db/server', () => ({
  initializeDb: initializeDbMock,
  bootstrapGeneratedAuthKeypairs: bootstrapGeneratedAuthKeypairsMock,
}));

vi.mock('../env', () => ({
  assertSecureWebBoot: assertSecureWebBootMock,
  initializeWebRuntimeEnv: initializeWebRuntimeEnvMock,
  installWebSecretProvider: installWebSecretProviderMock,
  rehydrateWebEnv: rehydrateWebEnvMock,
}));

const testEnv = {
  DATABASE_URL: 'postgres://postgres:password@localhost:15432/roomote_test',
  JOB_AUTH_PRIVATE_KEY: 'job-private-key',
  JOB_AUTH_PUBLIC_KEY: 'job-public-key',
  NODE_ENV: 'test',
  PREVIEW_AUTH_PRIVATE_KEY: 'preview-private-key',
  PREVIEW_AUTH_PUBLIC_KEY: 'preview-public-key',
};

describe('bootstrapWebRuntimeEnv', () => {
  const originalNextRuntime = process.env.NEXT_RUNTIME;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.NEXT_RUNTIME = 'nodejs';
    initializeWebRuntimeEnvMock.mockReturnValue(testEnv);
    initializeDbMock.mockResolvedValue({});
    bootstrapGeneratedAuthKeypairsMock.mockResolvedValue(false);
    rehydrateWebEnvMock.mockReturnValue(testEnv);
  });

  afterAll(() => {
    if (originalNextRuntime === undefined) {
      delete process.env.NEXT_RUNTIME;
    } else {
      process.env.NEXT_RUNTIME = originalNextRuntime;
    }
  });

  it('shares an in-flight database initialization across concurrent calls', async () => {
    let resolveInitializeDb: (() => void) | undefined;
    initializeDbMock.mockReturnValue(
      new Promise((resolve) => {
        resolveInitializeDb = () => resolve({});
      }),
    );

    const { bootstrapWebRuntimeEnv } = await import('../bootstrap-runtime-env');

    const first = bootstrapWebRuntimeEnv();
    const second = bootstrapWebRuntimeEnv();

    expect(initializeWebRuntimeEnvMock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(initializeDbMock).toHaveBeenCalledTimes(1);
    });
    expect(initializeDbMock).toHaveBeenCalledWith(testEnv.DATABASE_URL);

    resolveInitializeDb?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      testEnv,
      testEnv,
    ]);
    expect(configureAuthClientEnvMock).toHaveBeenCalledTimes(1);
    expect(installWebSecretProviderMock).toHaveBeenCalledTimes(1);
  });

  it('reuses the completed bootstrap for sequential calls', async () => {
    const { bootstrapWebRuntimeEnv } = await import('../bootstrap-runtime-env');

    await expect(bootstrapWebRuntimeEnv()).resolves.toBe(testEnv);
    await expect(bootstrapWebRuntimeEnv()).resolves.toBe(testEnv);

    expect(initializeWebRuntimeEnvMock).toHaveBeenCalledTimes(1);
    expect(initializeDbMock).toHaveBeenCalledTimes(1);
    expect(configureAuthClientEnvMock).toHaveBeenCalledTimes(1);
  });

  it('clears the in-flight bootstrap after a failure so callers can retry', async () => {
    initializeDbMock
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce({});

    const { bootstrapWebRuntimeEnv } = await import('../bootstrap-runtime-env');

    await expect(bootstrapWebRuntimeEnv()).rejects.toThrow(
      'database unavailable',
    );
    await expect(bootstrapWebRuntimeEnv()).resolves.toBe(testEnv);

    expect(initializeDbMock).toHaveBeenCalledTimes(2);
  });

  it('rebuilds the web env after auth keypairs are auto-generated', async () => {
    const generatedEnv = {
      ...testEnv,
      JOB_AUTH_PRIVATE_KEY: 'generated-job-private-key',
      JOB_AUTH_PUBLIC_KEY: 'generated-job-public-key',
      PREVIEW_AUTH_PRIVATE_KEY: 'generated-preview-private-key',
      PREVIEW_AUTH_PUBLIC_KEY: 'generated-preview-public-key',
    };
    bootstrapGeneratedAuthKeypairsMock.mockResolvedValue(true);
    rehydrateWebEnvMock.mockReturnValue(generatedEnv);

    const { bootstrapWebRuntimeEnv } = await import('../bootstrap-runtime-env');

    await expect(bootstrapWebRuntimeEnv()).resolves.toBe(generatedEnv);

    expect(rehydrateWebEnvMock).toHaveBeenCalledTimes(1);
    expect(configureAuthClientEnvMock).toHaveBeenCalledWith(
      expect.objectContaining({
        jobAuthPrivateKey: 'generated-job-private-key',
        previewAuthPublicKey: 'generated-preview-public-key',
      }),
    );
  });

  it('does not rebuild the web env when no keypair was generated', async () => {
    const { bootstrapWebRuntimeEnv } = await import('../bootstrap-runtime-env');

    await expect(bootstrapWebRuntimeEnv()).resolves.toBe(testEnv);

    expect(bootstrapGeneratedAuthKeypairsMock).toHaveBeenCalledTimes(1);
    expect(rehydrateWebEnvMock).not.toHaveBeenCalled();
  });
});
