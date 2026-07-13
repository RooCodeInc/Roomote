const { envMock } = vi.hoisted(() => ({
  envMock: {
    APP_ENV: 'production',
    NODE_ENV: 'production',
    R_API_DEBUG_LOGS: undefined as string | undefined,
  },
}));

async function importLoggingModule(envOverrides?: {
  APP_ENV?: string;
  NODE_ENV?: string;
  R_API_DEBUG_LOGS?: string | undefined;
}) {
  vi.resetModules();
  vi.doMock('@roomote/env', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@roomote/env')>();

    return {
      ...actual,
      Env: Object.assign(envMock, {
        APP_ENV: 'production',
        NODE_ENV: 'production',
        R_API_DEBUG_LOGS: undefined,
        ...envOverrides,
      }),
    };
  });

  return import('../logging');
}

describe('API logging helpers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.doUnmock('@roomote/env');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('keeps webhook timeout failures at error level with concise formatting', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { logApiError } = await importLoggingModule();

    const timeoutError = new Error('Body Timeout Error');
    timeoutError.name = 'UND_ERR_BODY_TIMEOUT';
    timeoutError.cause = new Error('The operation was aborted');

    logApiError('[GitHub] processing error', timeoutError);

    expect(errorSpy).toHaveBeenCalledWith(
      '[GitHub] processing error: UND_ERR_BODY_TIMEOUT | Body Timeout Error | The operation was aborted',
    );
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('formats observed external requests on a single line', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { createSingleLineWarnLogger } = await importLoggingModule();
    const logger = createSingleLineWarnLogger();

    logger.warn('[Observed External Request]', {
      service: 'api',
      method: 'POST',
      url: 'https://api.openai.com/v1/responses',
      status: 200,
      durationMs: 2063,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      '[Observed External Request] service="api" method="POST" url="https://api.openai.com/v1/responses" status=200 durationMs=2063',
    );
  });

  it('re-evaluates API debug flags at call time instead of caching them at import time', async () => {
    const debugSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { apiLogger } = await importLoggingModule();
    const baselineCallCount = debugSpy.mock.calls.length;

    apiLogger.debug('[GitHub] disabled');
    envMock.R_API_DEBUG_LOGS = '1';
    apiLogger.debug('[GitHub] enabled later');

    const newCalls = debugSpy.mock.calls.slice(baselineCallCount);

    expect(newCalls).not.toContainEqual(['[GitHub] disabled']);
    expect(newCalls).toContainEqual(['[GitHub] enabled later']);
  });
});
