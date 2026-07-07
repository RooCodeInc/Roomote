const { envMock } = vi.hoisted(() => ({
  envMock: {
    APP_ENV: 'production',
    NODE_ENV: 'production',
    API_DEBUG_LOGS: undefined as string | undefined,
    SLACK_DEBUG_LOGS: undefined as string | undefined,
  },
}));

async function importLoggingModule(envOverrides?: {
  APP_ENV?: string;
  NODE_ENV?: string;
  API_DEBUG_LOGS?: string | undefined;
  SLACK_DEBUG_LOGS?: string | undefined;
}) {
  vi.resetModules();
  vi.doMock('@roomote/env', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@roomote/env')>();

    return {
      ...actual,
      Env: Object.assign(envMock, {
        APP_ENV: 'production',
        NODE_ENV: 'production',
        API_DEBUG_LOGS: undefined,
        SLACK_DEBUG_LOGS: undefined,
        ...envOverrides,
      }),
    };
  });

  return import('../logging');
}

describe('logging helpers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.doUnmock('@roomote/env');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('enables slackDebug in production when SLACK_DEBUG_LOGS is set', async () => {
    const debugSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { slackDebug } = await importLoggingModule({
      SLACK_DEBUG_LOGS: '1',
    });

    slackDebug('[queueSlackMessage] enabled');

    expect(debugSpy).toHaveBeenCalledWith('[queueSlackMessage] enabled');
  });

  it('keeps API_DEBUG_LOGS as a production fallback for shared Slack traces in api processes', async () => {
    const debugSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { slackDebug } = await importLoggingModule({
      API_DEBUG_LOGS: 'true',
    });

    slackDebug('[queueSlackMessage] enabled');

    expect(debugSpy).toHaveBeenCalledWith('[queueSlackMessage] enabled');
  });

  it('suppresses slackDebug in production when neither debug flag is set', async () => {
    const debugSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { slackDebug } = await importLoggingModule();

    slackDebug('[queueSlackMessage] disabled');

    expect(debugSpy).not.toHaveBeenCalled();
  });

  it('re-evaluates debug flags at call time instead of caching them at import time', async () => {
    const debugSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { slackDebug } = await importLoggingModule();

    slackDebug('[queueSlackMessage] disabled');
    envMock.SLACK_DEBUG_LOGS = '1';
    slackDebug('[queueSlackMessage] enabled later');

    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledWith('[queueSlackMessage] enabled later');
  });

  it('keeps Slack Web API timeout failures at error level with concise formatting', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const timeoutError = new Error('Body Timeout Error');
    timeoutError.name = 'UND_ERR_BODY_TIMEOUT';
    timeoutError.cause = new Error('The operation was aborted');

    const { logSlackError } = await importLoggingModule();
    logSlackError('[SlackNotifier] Failed to unfurl task URL', timeoutError);

    expect(errorSpy).toHaveBeenCalledWith(
      '[SlackNotifier] Failed to unfurl task URL: UND_ERR_BODY_TIMEOUT | Body Timeout Error | The operation was aborted',
    );
    expect(debugSpy).not.toHaveBeenCalled();
  });
});
