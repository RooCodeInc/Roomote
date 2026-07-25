const sentryState = vi.hoisted(() => {
  return {
    init: vi.fn(),
  };
});

vi.mock('@sentry/node', () => ({
  init: sentryState.init,
}));

describe('api sentry monitoring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.API_SENTRY_DSN;
    delete process.env.SENTRY_DSN;
    delete process.env.R_APP_ENV;
    delete process.env.APP_ENV;
    delete process.env.NODE_ENV;
  });

  it('disables Sentry when the app environment is development', async () => {
    process.env.R_APP_ENV = 'development';

    const { initApiSentry } = await import('./sentry');

    expect(initApiSentry()).toBe(false);
    expect(sentryState.init).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
        environment: 'development',
      }),
    );
  });

  it('defaults to development when the environment is unset', async () => {
    const { initApiSentry } = await import('./sentry');

    expect(initApiSentry()).toBe(false);
    expect(sentryState.init).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
        environment: 'development',
      }),
    );
  });

  it('enables Sentry outside development only when a DSN is configured', async () => {
    process.env.R_APP_ENV = 'production';
    process.env.API_SENTRY_DSN = 'https://api.example/1';

    const { initApiSentry } = await import('./sentry');

    expect(initApiSentry()).toBe(true);
    expect(sentryState.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: 'https://api.example/1',
        enabled: true,
        environment: 'production',
      }),
    );
  });

  it('stays disabled outside development when no DSN is configured', async () => {
    process.env.R_APP_ENV = 'production';

    const { initApiSentry } = await import('./sentry');

    expect(initApiSentry()).toBe(false);
    expect(sentryState.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: undefined,
        enabled: false,
        environment: 'production',
      }),
    );
  });
});
