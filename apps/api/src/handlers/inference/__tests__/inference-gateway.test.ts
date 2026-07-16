import { Hono } from 'hono';
import type { AuthTokenContext, RunTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';

const { mockFindTaskRun, mockResolveModelProviderEnvValue } = vi.hoisted(
  () => ({
    mockFindTaskRun: vi.fn(),
    mockResolveModelProviderEnvValue: vi.fn(),
  }),
);

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: { findFirst: mockFindTaskRun },
    },
  },
  taskRuns: { id: 'id' },
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  resolveModelProviderEnvValue: mockResolveModelProviderEnvValue,
}));

import { inference } from '../index';

function createApp(authContext: Variables['authContext']) {
  const app = new Hono<{ Variables: Variables }>();

  app.use('*', async (c, next) => {
    c.set('authContext', authContext);
    await next();
  });

  app.route('/api/inference', inference);
  return app;
}

function createRunToken(overrides?: Partial<RunTokenContext>): RunTokenContext {
  return {
    runId: 42,
    userId: null,
    principal: 'deployment',
    tokenType: 'run',
    version: 1,
    ...(overrides ?? {}),
  };
}

function createUserToken(): AuthTokenContext {
  return {
    userId: 'user-1',
    tokenType: 'auth',
  } as AuthTokenContext;
}

function stubUpstreamFetch(response?: Response) {
  const fetchMock = vi.fn().mockResolvedValue(
    response ??
      new Response(JSON.stringify({ id: 'msg_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function postMessages(
  app: Hono<{ Variables: Variables }>,
  path = '/api/inference/anthropic/v1/messages',
  headers: Record<string, string> = {},
) {
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer run-token-value',
      ...headers,
    },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16 }),
  });
}

describe('inference gateway', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mockFindTaskRun.mockResolvedValue({ id: 42 });
    mockResolveModelProviderEnvValue.mockResolvedValue('provider-secret-key');
  });

  it('rejects user auth tokens', async () => {
    const fetchMock = stubUpstreamFetch();
    const response = await postMessages(createApp(createUserToken()));

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects requests with no auth context', async () => {
    const fetchMock = stubUpstreamFetch();
    const response = await postMessages(createApp(undefined));

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects run tokens whose task run no longer exists', async () => {
    const fetchMock = stubUpstreamFetch();
    mockFindTaskRun.mockResolvedValue(undefined);

    const response = await postMessages(createApp(createRunToken()));

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unknown providers', async () => {
    const fetchMock = stubUpstreamFetch();
    const response = await postMessages(
      createApp(createRunToken()),
      '/api/inference/not-a-provider/v1/messages',
    );

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects upstream paths outside the provider allowlist', async () => {
    const fetchMock = stubUpstreamFetch();
    const response = await postMessages(
      createApp(createRunToken()),
      '/api/inference/anthropic/v1/organizations/members',
    );

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects sibling paths that share an allowed prefix without a separator', async () => {
    const fetchMock = stubUpstreamFetch();
    const response = await postMessages(
      createApp(createRunToken()),
      '/api/inference/anthropic/v1/messages-admin',
    );

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the provider key is not configured', async () => {
    const fetchMock = stubUpstreamFetch();
    mockResolveModelProviderEnvValue.mockResolvedValue(undefined);

    const response = await postMessages(createApp(createRunToken()));

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards to the upstream with the provider key and strips the run token', async () => {
    const fetchMock = stubUpstreamFetch();
    const response = await postMessages(
      createApp(createRunToken()),
      undefined,
      {
        'anthropic-version': '2023-06-01',
      },
    );

    expect(response.status).toBe(200);
    expect(mockResolveModelProviderEnvValue).toHaveBeenCalledWith(
      'ANTHROPIC_API_KEY',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');

    const headers = new Headers(init.headers);
    expect(headers.get('x-api-key')).toBe('provider-secret-key');
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('anthropic-version')).toBe('2023-06-01');

    const forwardedBody = await new Response(init.body).text();
    expect(JSON.parse(forwardedBody)).toEqual({
      model: 'claude-sonnet-5',
      max_tokens: 16,
    });
  });

  it('sends Bearer-prefixed keys for bearer-auth providers', async () => {
    const fetchMock = stubUpstreamFetch();
    const response = await postMessages(
      createApp(createRunToken()),
      '/api/inference/openrouter/v1/chat/completions',
    );

    expect(response.status).toBe(200);
    expect(mockResolveModelProviderEnvValue).toHaveBeenCalledWith(
      'OPENROUTER_API_KEY',
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');

    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer provider-secret-key');
  });

  it('preserves the query string on upstream requests', async () => {
    const fetchMock = stubUpstreamFetch();
    const app = createApp(createRunToken());

    const response = await app.request(
      '/api/inference/google/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer run-token-value',
        },
        body: JSON.stringify({}),
      },
    );

    expect(response.status).toBe(200);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
    );

    const headers = new Headers(init.headers);
    expect(headers.get('x-goog-api-key')).toBe('provider-secret-key');
  });

  it('streams the upstream response body and status through', async () => {
    const upstreamBody = 'event: message_start\ndata: {}\n\n';
    stubUpstreamFetch(
      new Response(upstreamBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );

    const response = await postMessages(createApp(createRunToken()));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(await response.text()).toBe(upstreamBody);
  });

  it('passes upstream error statuses through', async () => {
    stubUpstreamFetch(
      new Response(JSON.stringify({ error: { type: 'overloaded_error' } }), {
        status: 529,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const response = await postMessages(createApp(createRunToken()));

    expect(response.status).toBe(529);
  });

  it('returns 502 when the upstream fetch fails', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error('connect ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    const response = await postMessages(createApp(createRunToken()));

    expect(response.status).toBe(502);
  });

  it('rejects unsupported methods', async () => {
    const fetchMock = stubUpstreamFetch();
    const app = createApp(createRunToken());

    const response = await app.request('/api/inference/anthropic/v1/messages', {
      method: 'DELETE',
      headers: { authorization: 'Bearer run-token-value' },
    });

    expect(response.status).toBe(405);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
