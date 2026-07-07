const { sentryInitMock, sentryReplayIntegrationMock } = vi.hoisted(() => ({
  sentryInitMock: vi.fn(),
  sentryReplayIntegrationMock: vi.fn(
    (..._args: unknown[]) => 'replay-integration',
  ),
}));

vi.mock('@/lib/sentry-config', () => ({
  isWebSentryEnabled: () => true,
  resolveWebSentryEnvironment: () => 'test',
  resolveWebSentryRelease: () => 'test-release',
}));

vi.mock('@sentry/nextjs', () => ({
  captureRouterTransitionStart: vi.fn(),
  init: (...args: unknown[]) => sentryInitMock(...args),
  replayIntegration: (...args: unknown[]) =>
    sentryReplayIntegrationMock(...args),
}));

describe('web client instrumentation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('initializes client Sentry with explicit release attribution', async () => {
    await import('../instrumentation-client');

    expect(sentryInitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: 'test',
        release: 'test-release',
      }),
    );
  });
});
