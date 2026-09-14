const {
  bootstrapWebRuntimeEnvMock,
  installWebFastAgentGracefulShutdownMock,
  sentryInitMock,
} = vi.hoisted(() => ({
  bootstrapWebRuntimeEnvMock: vi.fn(),
  installWebFastAgentGracefulShutdownMock: vi.fn(),
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

vi.mock('@/lib/server/fast-agent-graceful-shutdown', () => ({
  WEB_FAST_AGENT_SHUTDOWN_READY: 'roomote:web-fast-agent-shutdown-ready',
  installWebFastAgentGracefulShutdown: (options: unknown) =>
    installWebFastAgentGracefulShutdownMock(options),
}));

vi.mock('@sentry/nextjs', () => ({
  init: (...args: unknown[]) => sentryInitMock(...args),
  captureRequestError: vi.fn(),
}));

describe('web instrumentation', () => {
  const originalNextRuntime = process.env.NEXT_RUNTIME;
  const originalCoordinatedShutdown =
    process.env.ROOMOTE_WEB_SHUTDOWN_COORDINATED;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.ROOMOTE_WEB_SHUTDOWN_COORDINATED;
  });

  afterAll(() => {
    if (originalNextRuntime === undefined) {
      delete process.env.NEXT_RUNTIME;
    } else {
      process.env.NEXT_RUNTIME = originalNextRuntime;
    }
    if (originalCoordinatedShutdown === undefined) {
      delete process.env.ROOMOTE_WEB_SHUTDOWN_COORDINATED;
    } else {
      process.env.ROOMOTE_WEB_SHUTDOWN_COORDINATED =
        originalCoordinatedShutdown;
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

  it('installs Fast handoff only in the coordinated Next child', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    process.env.ROOMOTE_WEB_SHUTDOWN_COORDINATED = 'true';

    const instrumentation = await import('../instrumentation');
    await instrumentation.register();

    expect(installWebFastAgentGracefulShutdownMock).toHaveBeenCalledWith({
      notifyReady: expect.any(Function),
    });
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
