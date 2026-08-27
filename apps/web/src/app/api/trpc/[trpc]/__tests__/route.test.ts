import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

import { logger } from '@/lib/server/logger';

import { maxDuration, POST } from '../route';

vi.mock('@/lib/server/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const { createContextMock } = vi.hoisted(() => ({
  createContextMock: vi.fn(),
}));

vi.mock('@/trpc/init', () => ({
  createContext: createContextMock,
}));

vi.mock('@/trpc/routers/_app', () => ({
  appRouter: { _def: {} },
}));

vi.mock('@trpc/server/adapters/fetch', () => ({
  fetchRequestHandler: vi.fn(),
}));

const infoMock = vi.mocked(logger.info);
const fetchRequestHandlerMock = vi.mocked(fetchRequestHandler);

describe('POST /api/trpc/[trpc]', () => {
  let clock = 0;
  let responseMetaResult: unknown;

  beforeEach(() => {
    vi.clearAllMocks();
    clock = 0;
    responseMetaResult = undefined;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);

    createContextMock.mockImplementation(async () => {
      // Time spent resolving the session, which runs even for requests that
      // are rejected as unauthenticated.
      clock += 30;
      return { auth: { success: false } };
    });

    // Stand-in for tRPC: burn time before and after context creation, ask for
    // response metadata the way the streaming adapter does, then answer.
    fetchRequestHandlerMock.mockImplementation(async (opts) => {
      clock += 5;
      await (opts.createContext as (input: unknown) => Promise<unknown>)({});
      clock += 15;
      responseMetaResult = opts.responseMeta?.({
        data: [],
        ctx: undefined,
        paths: ['tasks.get'],
        info: undefined,
        type: 'query',
        errors: [],
        eagerGeneration: true,
      });

      return new Response('{"result":{}}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const call = () =>
    POST(
      new Request('https://app.test/api/trpc/tasks.get,users.me?batch=1', {
        method: 'POST',
      }),
    );

  it('allows post-response Fast turns to reach their recovery deadline', () => {
    expect(maxDuration).toBe(800);
  });

  it('emits one request-timing line with the auth and handler durations', async () => {
    const response = await call();

    // The line is emitted once the response body has been flushed.
    expect(infoMock).not.toHaveBeenCalled();

    await expect(response.text()).resolves.toBe('{"result":{}}');

    expect(infoMock).toHaveBeenCalledTimes(1);
    expect(infoMock).toHaveBeenCalledWith(
      '[request-timing] path=/api/trpc/tasks.get,users.me procedures=tasks.get,users.me auth=30 handler=50 status=200 batch=2 total=50',
    );
  });

  it('exposes the known phases through Server-Timing', async () => {
    const response = await call();

    // Streaming responses ask for metadata before any procedure resolves, so
    // only the auth phase is knowable there.
    expect(responseMetaResult).toEqual({
      headers: { 'server-timing': 'auth;dur=30' },
    });
    expect(response.headers.get('server-timing')).toBe('handler;dur=50');

    await response.text();
  });

  it('still reports when context creation fails', async () => {
    createContextMock.mockImplementation(async () => {
      clock += 12;
      throw new Error('session lookup failed');
    });
    fetchRequestHandlerMock.mockImplementation(async (opts) => {
      clock += 5;

      try {
        await (opts.createContext as (input: unknown) => Promise<unknown>)({});
      } catch {
        // tRPC turns this into an error response rather than rejecting.
      }

      return new Response('{"error":{}}', { status: 500 });
    });

    const response = await call();
    await response.text();

    expect(infoMock).toHaveBeenCalledWith(
      '[request-timing] path=/api/trpc/tasks.get,users.me procedures=tasks.get,users.me auth=12 handler=17 status=500 batch=2 total=17',
    );
  });
});
