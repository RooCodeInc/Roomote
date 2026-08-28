import { Hono } from 'hono';

import type { Variables } from '../../../types';

const {
  mockGetBrainGatewayToken,
  mockResolveBrainInferenceProvider,
  mockMapBrainModelName,
  mockEnv,
} = vi.hoisted(() => ({
  mockGetBrainGatewayToken: vi.fn(),
  mockResolveBrainInferenceProvider: vi.fn(),
  mockMapBrainModelName: vi.fn(),
  mockEnv: {} as Record<string, string | undefined>,
}));

vi.mock('@roomote/env', () => ({ Env: mockEnv }));

vi.mock('@roomote/sdk/server', () => ({
  getBrainGatewayToken: mockGetBrainGatewayToken,
  resolveBrainInferenceProvider: mockResolveBrainInferenceProvider,
  mapBrainModelName: mockMapBrainModelName,
}));

const { brainInference } = await import('../index');

const GATEWAY_TOKEN = 'brain-gateway-token-value-0123456789';

const OPENROUTER = {
  providerId: 'openrouter' as const,
  apiKey: 'sk-or-provider-key',
  models: {
    embedding: 'openai/text-embedding-3-small',
    chat: 'openai/gpt-5.6-luna',
  },
};

function makeApp() {
  const app = new Hono<{ Variables: Variables }>();
  app.route('/api/brain/inference', brainInference);
  return app;
}

async function post(
  path: string,
  options: { token?: string; body?: unknown } = {},
) {
  return makeApp().request(`/api/brain/inference${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: JSON.stringify(options.body ?? {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  for (const key of Object.keys(mockEnv)) {
    delete mockEnv[key];
  }
  mockGetBrainGatewayToken.mockReturnValue(GATEWAY_TOKEN);
  mockResolveBrainInferenceProvider.mockResolvedValue(OPENROUTER);
  mockMapBrainModelName.mockImplementation((requested: string) =>
    requested === 'text-embedding-3-small'
      ? 'openai/text-embedding-3-small'
      : requested,
  );
});

describe('brain inference gateway', () => {
  it('404s when no gateway token is configured', async () => {
    mockGetBrainGatewayToken.mockReturnValue(null);

    const response = await post('/v1/embeddings', { token: GATEWAY_TOKEN });

    expect(response.status).toBe(404);
  });

  it('rejects a missing or wrong token without reaching a provider', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect((await post('/v1/embeddings')).status).toBe(401);
    expect((await post('/v1/embeddings', { token: 'wrong' })).status).toBe(401);
    expect(
      (await post('/v1/embeddings', { token: `${GATEWAY_TOKEN}x` })).status,
    ).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses paths outside the Brain surface', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect((await post('/v1/models', { token: GATEWAY_TOKEN })).status).toBe(
      403,
    );
    expect(
      (await post('/v1/admin/keys', { token: GATEWAY_TOKEN })).status,
    ).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports 503 when the deployment has no provider configured', async () => {
    mockResolveBrainInferenceProvider.mockResolvedValue(null);

    const response = await post('/v1/embeddings', { token: GATEWAY_TOKEN });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('Settings'),
    });
  });

  it('swaps the gateway token for the provider key and rewrites the model', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await post('/v1/embeddings', {
      token: GATEWAY_TOKEN,
      body: { model: 'text-embedding-3-small', input: ['hello'] },
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const call = fetchMock.mock.calls[0]!;
    const url = call[0];
    const init = call[1];
    expect(url).toBe('https://openrouter.ai/api/v1/embeddings');

    const headers = init.headers as Headers;
    // The Brain's own credential must never reach the provider.
    expect(headers.get('authorization')).toBe(`Bearer ${OPENROUTER.apiKey}`);
    expect(headers.get('authorization')).not.toContain(GATEWAY_TOKEN);

    expect(JSON.parse(init.body as string)).toEqual({
      model: 'openai/text-embedding-3-small',
      input: ['hello'],
    });
  });

  it('surfaces an unreachable provider as 502 rather than a crash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      }),
    );

    const response = await post('/v1/embeddings', {
      token: GATEWAY_TOKEN,
      body: { model: 'text-embedding-3-small', input: ['hello'] },
    });

    expect(response.status).toBe(502);
  });

  it('forwards an operator-chosen model when one is configured', async () => {
    // The Brain keeps asking for what it was built with; the deployment
    // decides what that resolves to, which is what makes the model an env
    // setting rather than a property of the container.
    mockMapBrainModelName.mockReturnValue('openai/gpt-5.6-mini');

    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await post('/v1/chat/completions', {
      token: GATEWAY_TOKEN,
      body: { model: 'openai/gpt-5.6-luna', messages: [] },
    });

    const init = fetchMock.mock.calls[0]![1];
    expect(JSON.parse(init.body as string).model).toBe('openai/gpt-5.6-mini');
  });
});

describe('local inference upstreams', () => {
  it('routes embeddings to the configured upstream without touching the provider', async () => {
    mockEnv.R_BRAIN_EMBEDDINGS_UPSTREAM_URL = 'http://infinity:7997';
    mockEnv.R_BRAIN_INFERENCE_UPSTREAM_API_KEY = 'local-upstream-key';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await post('/v1/embeddings', {
      token: GATEWAY_TOKEN,
      body: { model: 'bge-small-en-v1.5', input: 'hello' },
    });

    expect(response.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://infinity:7997/v1/embeddings');
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get('authorization')).toBe('Bearer local-upstream-key');
    // Model name passes through unrewritten: the upstream owns its names.
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      model: 'bge-small-en-v1.5',
    });
    expect(mockMapBrainModelName).not.toHaveBeenCalled();
    expect(mockResolveBrainInferenceProvider).not.toHaveBeenCalled();
  });

  it('rejects the removed rerank path like any other unlisted path', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await post('/v1/rerank', {
      token: GATEWAY_TOKEN,
      body: { model: 'bge-reranker-base', query: 'q', documents: ['a'] },
    });

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the trailing slash on a configured upstream from doubling up', async () => {
    mockEnv.R_BRAIN_EMBEDDINGS_UPSTREAM_URL = 'http://infinity:7997/';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await post('/v1/embeddings', {
      token: GATEWAY_TOKEN,
      body: { model: 'bge-small-en-v1.5', input: ['a'] },
    });

    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'http://infinity:7997/v1/embeddings',
    );
  });

  it('sends no authorization header when the upstream has no key', async () => {
    mockEnv.R_BRAIN_EMBEDDINGS_UPSTREAM_URL = 'http://infinity:7997';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await post('/v1/embeddings', { token: GATEWAY_TOKEN, body: {} });

    // The gateway token must never be forwarded, and no invented key either.
    const headers = new Headers(
      (fetchMock.mock.calls[0]![1] as RequestInit).headers,
    );
    expect(headers.get('authorization')).toBeNull();
  });

  it('keeps chat on the provider even when upstreams are configured', async () => {
    mockEnv.R_BRAIN_EMBEDDINGS_UPSTREAM_URL = 'http://infinity:7997';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await post('/v1/chat/completions', {
      token: GATEWAY_TOKEN,
      body: { model: 'gpt-5.6-luna', messages: [] },
    });

    expect(mockResolveBrainInferenceProvider).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0]![0])).toContain('openrouter.ai');
  });

  it('still authenticates the caller before proxying to a local upstream', async () => {
    mockEnv.R_BRAIN_EMBEDDINGS_UPSTREAM_URL = 'http://infinity:7997';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await post('/v1/embeddings', { token: 'wrong-token' });

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
