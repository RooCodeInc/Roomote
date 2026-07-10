const sentryState = vi.hoisted(() => {
  const setLevel = vi.fn();
  const setTag = vi.fn();
  const setContext = vi.fn();
  const setUser = vi.fn();

  return {
    captureException: vi.fn(),
    flush: vi.fn().mockResolvedValue(true),
    init: vi.fn(),
    setContext,
    setLevel,
    setTag,
    setUser,
  };
});

vi.mock('@sentry/node', () => ({
  captureException: sentryState.captureException,
  flush: sentryState.flush,
  init: sentryState.init,
  withScope: (
    callback: (scope: {
      setLevel: typeof sentryState.setLevel;
      setTag: typeof sentryState.setTag;
      setContext: typeof sentryState.setContext;
      setUser: typeof sentryState.setUser;
    }) => void,
  ) =>
    callback({
      setLevel: sentryState.setLevel,
      setTag: sentryState.setTag,
      setContext: sentryState.setContext,
      setUser: sentryState.setUser,
    }),
}));

import { HTTPException } from 'hono/http-exception';

import { createApiApp } from '../server';

describe('API Sentry integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.APP_ENV = 'preview';
    process.env.API_SENTRY_DSN = 'https://api.example/1';
  });

  afterEach(() => {
    delete process.env.APP_ENV;
    delete process.env.API_SENTRY_DSN;
  });

  it('captures uncaught request errors and returns the shared 500 payload', async () => {
    const app = createApiApp();

    app.get('/boom', () => {
      throw new Error('boom');
    });

    const response = await app.request('http://localhost/boom', {
      headers: {
        'x-request-id': 'req-api-sentry-1',
      },
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'internal_server_error',
    });

    expect(sentryState.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: 'https://api.example/1',
        sendDefaultPii: false,
        serverName: 'api',
      }),
    );
    expect(sentryState.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'boom',
      }),
    );
    expect(sentryState.setTag).toHaveBeenCalledWith('roomote.method', 'GET');
    expect(sentryState.setTag).toHaveBeenCalledWith('roomote.path', '/boom');
    expect(sentryState.setTag).toHaveBeenCalledWith(
      'roomote.request_id',
      'req-api-sentry-1',
    );
    expect(sentryState.setContext).toHaveBeenCalledWith(
      'request',
      expect.objectContaining({
        method: 'GET',
        path: '/boom',
        requestId: 'req-api-sentry-1',
      }),
    );
  });

  it('does not report expected HTTPException responses to Sentry', async () => {
    const app = createApiApp();

    app.get('/teapot', () => {
      throw new HTTPException(418, {
        message: 'teapot',
      });
    });

    const response = await app.request('http://localhost/teapot');

    expect(response.status).toBe(418);
    expect(sentryState.captureException).not.toHaveBeenCalled();
  });

  it('still reports HTTPException responses that represent server errors', async () => {
    const app = createApiApp();

    app.get('/server-error', () => {
      throw new HTTPException(503, {
        message: 'upstream unavailable',
      });
    });

    const response = await app.request('http://localhost/server-error');

    expect(response.status).toBe(503);
    expect(sentryState.captureException).toHaveBeenCalledTimes(1);
  });
});
