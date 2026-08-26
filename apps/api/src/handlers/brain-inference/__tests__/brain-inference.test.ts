import { Hono } from 'hono';

import type { Variables } from '../../../types';

const {
  mockGetBrainGatewayToken,
  mockResolveBrainInferenceProvider,
  mockMapBrainModelName,
  mockRecordLlmUsage,
} = vi.hoisted(() => ({
  mockGetBrainGatewayToken: vi.fn(),
  mockResolveBrainInferenceProvider: vi.fn(),
  mockMapBrainModelName: vi.fn(),
  mockRecordLlmUsage: vi.fn(),
}));

vi.mock('@roomote/sdk/server', () => ({
  getBrainGatewayToken: mockGetBrainGatewayToken,
  resolveBrainInferenceProvider: mockResolveBrainInferenceProvider,
  mapBrainModelName: mockMapBrainModelName,
  recordLlmUsage: mockRecordLlmUsage,
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
  mockGetBrainGatewayToken.mockReturnValue(GATEWAY_TOKEN);
  mockResolveBrainInferenceProvider.mockResolvedValue(OPENROUTER);
  mockRecordLlmUsage.mockResolvedValue({ recorded: true });
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

  it('records embedding tokens, provider cost, and request diagnostics', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          data: [],
          usage: {
            prompt_tokens: 12,
            total_tokens: 12,
            cost: 0.0000042,
            cost_details: { upstream_inference_cost: 0.000004 },
          },
          model: 'openai/text-embedding-3-small-2026-08-01',
        }),
      ),
    );

    const response = await post('/v1/embeddings', {
      token: GATEWAY_TOKEN,
      body: { model: 'text-embedding-3-small', input: ['hello'] },
    });

    expect(response.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockRecordLlmUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          eventKey: expect.stringMatching(/^brain-inference-gateway:/u),
          source: 'brain-inference-gateway',
          usageType: 'embedding',
          providerId: 'openrouter',
          modelId: 'openai/text-embedding-3-small-2026-08-01',
          inputTokens: 12,
          totalTokens: 12,
          costMicroUsd: 4,
          costSource: 'provider_response',
          pricingMetadata: {
            costDetails: { upstream_inference_cost: 0.000004 },
          },
          details: expect.objectContaining({
            operation: 'embeddings',
            upstreamPath: '/v1/embeddings',
            status: 200,
            latencyMs: expect.any(Number),
            usageMetadataAvailable: true,
            metadataReadFailed: false,
          }),
        }),
      );
    });
  });

  it('routes reranking through OpenRouter without exposing its key to gbrain', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const body = {
      model: 'cohere/rerank-v3.5',
      query: 'Which result is relevant?',
      documents: ['relevant', 'unrelated'],
      top_n: 2,
    };
    const response = await post('/v1/rerank', {
      token: GATEWAY_TOKEN,
      body,
    });

    expect(response.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/rerank');
    expect((init.headers as Headers).get('authorization')).toBe(
      `Bearer ${OPENROUTER.apiKey}`,
    );
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it('records metadata-free reranking with missing cost instead of dropping it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ results: [] })),
    );

    const response = await post('/v1/rerank', {
      token: GATEWAY_TOKEN,
      body: {
        model: 'cohere/rerank-v3.5',
        query: 'query',
        documents: ['document'],
      },
    });

    expect(response.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockRecordLlmUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          usageType: 'rerank',
          providerId: 'openrouter',
          modelId: 'cohere/rerank-v3.5',
          costMicroUsd: null,
          costSource: 'missing',
          details: expect.objectContaining({
            operation: 'rerank',
            status: 200,
            usageMetadataAvailable: false,
          }),
        }),
      );
    });
  });

  it('reports reranking as unavailable when only OpenAI is configured', async () => {
    mockResolveBrainInferenceProvider.mockResolvedValue({
      providerId: 'openai',
      apiKey: 'sk-openai-provider-key',
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await post('/v1/rerank', {
      token: GATEWAY_TOKEN,
      body: {
        model: 'cohere/rerank-v3.5',
        query: 'query',
        documents: ['document'],
      },
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('OpenRouter'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
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
    await vi.waitFor(() => {
      expect(mockRecordLlmUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          usageType: 'embedding',
          providerId: 'openrouter',
          modelId: 'openai/text-embedding-3-small',
          costMicroUsd: null,
          costSource: 'missing',
          details: expect.objectContaining({
            operation: 'embeddings',
            status: 502,
            usageMetadataAvailable: false,
          }),
        }),
      );
    });
  });

  it('records an upstream provider failure with its actual status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: 'rate limited' }, { status: 429 }),
      ),
    );

    const response = await post('/v1/chat/completions', {
      token: GATEWAY_TOKEN,
      body: { model: 'gpt-5.6-luna', messages: [] },
    });

    expect(response.status).toBe(429);
    await vi.waitFor(() => {
      expect(mockRecordLlmUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          usageType: 'inference',
          providerId: 'openrouter',
          modelId: 'gpt-5.6-luna',
          costSource: 'missing',
          details: expect.objectContaining({
            operation: 'chat_completions',
            status: 429,
            usageMetadataAvailable: false,
          }),
        }),
      );
    });
  });

  it('normalizes response API streaming token details as inference usage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            'data: {"type":"response.completed","response":{"usage":{"input_tokens":30,"output_tokens":8,"total_tokens":38,"input_tokens_details":{"cached_tokens":10},"output_tokens_details":{"reasoning_tokens":3}}}}\n\ndata: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      ),
    );

    const response = await post('/v1/responses', {
      token: GATEWAY_TOKEN,
      body: { model: 'gpt-5.6-luna', input: 'hello', stream: true },
    });

    expect(response.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockRecordLlmUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          usageType: 'inference',
          modelId: 'gpt-5.6-luna',
          inputTokens: 30,
          outputTokens: 8,
          reasoningTokens: 3,
          cacheReadTokens: 10,
          totalTokens: 38,
          details: expect.objectContaining({ operation: 'responses' }),
        }),
      );
    });
  });

  it('requests usage metadata for OpenAI-compatible chat streams', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({ choices: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await post('/v1/chat/completions', {
      token: GATEWAY_TOKEN,
      body: {
        model: 'gpt-5.6-luna',
        messages: [],
        stream: true,
        stream_options: { custom_option: true },
      },
    });

    const init = fetchMock.mock.calls[0]![1];
    expect(JSON.parse(init.body as string)).toMatchObject({
      stream_options: { custom_option: true, include_usage: true },
    });
  });

  it('records the final usage chunk from a chat completions stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            'data: {"choices":[],"model":"openai/gpt-5.6-luna","usage":{"prompt_tokens":21,"completion_tokens":5,"total_tokens":26,"cost":0.0009}}\n\ndata: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      ),
    );

    const response = await post('/v1/chat/completions', {
      token: GATEWAY_TOKEN,
      body: { model: 'gpt-5.6-luna', messages: [], stream: true },
    });

    expect(response.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockRecordLlmUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          usageType: 'inference',
          modelId: 'openai/gpt-5.6-luna',
          inputTokens: 21,
          outputTokens: 5,
          totalTokens: 26,
          costMicroUsd: 900,
          costSource: 'provider_response',
          details: expect.objectContaining({
            operation: 'chat_completions',
            status: 200,
            usageMetadataAvailable: true,
          }),
        }),
      );
    });
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
