const { bootstrapWebRuntimeEnvMock, sentryInitMock } = vi.hoisted(() => ({
  bootstrapWebRuntimeEnvMock: vi.fn(),
  sentryInitMock: vi.fn(),
}));

vi.mock('@/lib/server/bootstrap-runtime-env', () => ({
  bootstrapWebRuntimeEnv: () => bootstrapWebRuntimeEnvMock(),
}));

vi.mock('@/lib/sentry-config', () => ({
  isWebSentryEnabled: () => true,
  resolveWebSentryEnvironment: () => 'test',
  resolveWebSentryRelease: () => 'test-release',
}));

vi.mock('@sentry/nextjs', () => ({
  init: (...args: unknown[]) => sentryInitMock(...args),
  captureRequestError: vi.fn(),
}));

describe('web instrumentation', () => {
  const originalNextRuntime = process.env.NEXT_RUNTIME;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterAll(() => {
    if (originalNextRuntime === undefined) {
      delete process.env.NEXT_RUNTIME;
    } else {
      process.env.NEXT_RUNTIME = originalNextRuntime;
    }
  });

  it('bootstraps runtime env during register()', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';

    const instrumentation = await import('../instrumentation');

    expect(bootstrapWebRuntimeEnvMock).not.toHaveBeenCalled();

    await instrumentation.register();

    expect(bootstrapWebRuntimeEnvMock).toHaveBeenCalledTimes(1);
    expect(sentryInitMock).toHaveBeenCalledTimes(1);
  });

  it('initializes node runtime Sentry with explicit release attribution', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';

    const instrumentation = await import('../instrumentation');

    await instrumentation.register();

    expect(sentryInitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: 'test',
        release: 'test-release',
      }),
    );
  });

  it('initializes edge runtime Sentry with explicit release attribution', async () => {
    process.env.NEXT_RUNTIME = 'edge';

    const instrumentation = await import('../instrumentation');

    await instrumentation.register();

    expect(bootstrapWebRuntimeEnvMock).not.toHaveBeenCalled();
    expect(sentryInitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: 'test',
        release: 'test-release',
      }),
    );
  });
});
