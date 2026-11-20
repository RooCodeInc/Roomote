import { once } from 'node:events';
import { createServer } from 'node:http';

import {
  discoverProviderModels,
  getRecommendedLocalProviderModels,
  LOCAL_TASK_MODEL_PROVIDER_IDS,
  qualifyProviderModel,
} from './local-provider-discovery';

const { mockGetPersistedEnvironmentVariableValues } = vi.hoisted(() => ({
  mockGetPersistedEnvironmentVariableValues: vi.fn(),
}));

vi.mock('../environment-variables', () => ({
  getPersistedEnvironmentVariableValues:
    mockGetPersistedEnvironmentVariableValues,
}));

describe('LOCAL_TASK_MODEL_PROVIDER_IDS', () => {
  it('comes from setup catalog endpoint providers with dynamic models', () => {
    expect([...LOCAL_TASK_MODEL_PROVIDER_IDS].sort()).toEqual([
      'litellm',
      'ollama',
      'openai-compatible',
      'vllm',
    ]);
  });
});

describe('getRecommendedLocalProviderModels', () => {
  it('prefers capable coding models and excludes tiny or specialized models', () => {
    const recommended = getRecommendedLocalProviderModels([
      {
        modelId: 'ollama/tinyllama:1.1b',
        displayName: 'tinyllama:1.1b',
        family: null,
        metadata: null,
      },
      {
        modelId: 'ollama/nomic-embed-text',
        displayName: 'nomic-embed-text',
        family: null,
        metadata: null,
      },
      {
        modelId: 'ollama/llama3.3:70b',
        displayName: 'llama3.3:70b',
        family: null,
        metadata: null,
      },
      {
        modelId: 'ollama/qwen3-coder:30b',
        displayName: 'qwen3-coder:30b',
        family: null,
        metadata: null,
      },
    ]);

    expect(recommended.map((model) => model.modelId)).toEqual([
      'ollama/qwen3-coder:30b',
      'ollama/llama3.3:70b',
    ]);
  });

  it('does not automatically choose unknown local model aliases', () => {
    expect(
      getRecommendedLocalProviderModels([
        {
          modelId: 'litellm/team-default',
          displayName: 'team-default',
          family: null,
          metadata: null,
        },
      ]),
    ).toEqual([]);
  });
});

describe('discoverProviderModels', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    mockGetPersistedEnvironmentVariableValues.mockResolvedValue({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('discovers Ollama models from /api/tags and prefixes their IDs', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(
      discoverProviderModels({
        provider: 'ollama',
        baseUrl: 'http://ollama.example',
      }),
    ).resolves.toMatchObject({
      error: null,
      modelCount: 1,
      recommendedModels: [{ modelId: 'ollama/qwen3:8b' }],
      models: [
        {
          modelId: 'ollama/qwen3:8b',
          displayName: 'qwen3:8b',
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://ollama.example/api/tags',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('falls back to the OpenAI models endpoint when Ollama tags are unavailable', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: 'llama3.3' }] }), {
          headers: { 'content-type': 'application/json' },
        }),
      );

    await expect(
      discoverProviderModels({
        provider: 'ollama',
        baseUrl: 'http://ollama.example/v1',
      }),
    ).resolves.toMatchObject({
      error: null,
      models: [{ modelId: 'ollama/llama3.3' }],
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://ollama.example/v1/models',
      expect.anything(),
    );
  });

  it('preserves blocking Ollama failures when its fallback also fails', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    await expect(
      discoverProviderModels({
        provider: 'ollama',
        baseUrl: 'http://ollama.example',
      }),
    ).resolves.toMatchObject({
      models: [],
      failureReason: 'invalid_credentials',
      error: expect.stringContaining('rejected the API key'),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('discovers vLLM models from the OpenAI-compatible models endpoint', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'qwen3' }] }), {
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(
      discoverProviderModels({
        provider: 'vllm',
        baseUrl: 'https://vllm.example/v1',
        apiKey: 'submitted-key',
      }),
    ).resolves.toMatchObject({
      error: null,
      failureReason: null,
      models: [{ modelId: 'vllm/qwen3' }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://vllm.example/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer submitted-key' },
      }),
    );
  });

  it.each([
    [401, 'invalid_credentials', 'rejected the API key'],
    [402, 'insufficient_credits', 'enough credits or quota'],
    [404, 'endpoint_not_found', 'did not recognize this endpoint'],
    [429, 'rate_limited', 'rate limiting requests'],
    [503, 'provider_unavailable', 'server error (503)'],
  ] as const)(
    'classifies HTTP %d discovery failures as %s',
    async (status, reason, message) => {
      fetchMock.mockResolvedValue(new Response(null, { status }));

      await expect(
        discoverProviderModels({
          provider: 'vllm',
          baseUrl: 'https://vllm.example/v1',
        }),
      ).resolves.toMatchObject({
        models: [],
        failureReason: reason,
        error: expect.stringContaining(message),
      });
    },
  );

  it('classifies unreachable discovery endpoints separately', async () => {
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(
      discoverProviderModels({
        provider: 'vllm',
        baseUrl: 'https://vllm.example/v1',
      }),
    ).resolves.toMatchObject({
      models: [],
      failureReason: 'endpoint_unreachable',
    });
  });

  it('rejects a syntactically invalid endpoint before discovery', async () => {
    await expect(
      discoverProviderModels({
        provider: 'vllm',
        baseUrl: 'not a URL',
      }),
    ).resolves.toMatchObject({
      models: [],
      failureReason: 'invalid_endpoint',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses saved LiteLLM credentials and metadata when discovering models', async () => {
    mockGetPersistedEnvironmentVariableValues.mockResolvedValue({
      LITELLM_BASE_URL: 'https://litellm.example/v1',
      LITELLM_API_KEY: 'saved-key',
    });
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: 'azure/gpt-4o' }] }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                model_name: 'azure/gpt-4o',
                model_info: { max_input_tokens: 128_000 },
              },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );

    await expect(
      discoverProviderModels({ provider: 'litellm' }),
    ).resolves.toMatchObject({
      models: [
        {
          modelId: 'litellm/azure/gpt-4o',
          metadata: expect.objectContaining({ contextWindow: 128_000 }),
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://litellm.example/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer saved-key' },
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://litellm.example/model/info',
      expect.objectContaining({
        headers: { Authorization: 'Bearer saved-key' },
      }),
    );
  });
});

describe('qualifyProviderModel', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    mockGetPersistedEnvironmentVariableValues.mockResolvedValue({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    'completed',
    'failed',
    'incomplete',
    'truncated',
    'invalid-arguments',
    'missing-call-id',
  ])(
    'qualifies Responses-only HTTP endpoints through streamed tool output continuation: %s',
    async (outcome) => {
      vi.unstubAllGlobals();
      mockGetPersistedEnvironmentVariableValues.mockResolvedValue({
        OPENAI_COMPATIBLE_NATIVE_PROTOCOL: 'responses',
      });
      const requests: Array<{
        url?: string;
        body: Record<string, unknown>;
        authorization?: string;
      }> = [];
      const call = {
        type: 'function_call',
        id: 'fc_ping',
        call_id: 'call_ping',
        name: 'ping',
        arguments: '{}',
      };
      const server = createServer((request, response) => {
        let body = '';
        request.on('data', (chunk) => {
          body += chunk;
        });
        request.on('end', () => {
          const payload = JSON.parse(body);
          requests.push({
            url: request.url,
            body: payload,
            authorization: request.headers.authorization,
          });
          if (request.url !== '/prefix/v1/responses') {
            response.writeHead(404).end();
            return;
          }
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          const continuation = payload.tool_choice === 'none';
          const event = continuation
            ? {
                type: `response.${outcome}`,
                response: {
                  status: outcome,
                  output: [
                    {
                      type: 'message',
                      content: [{ type: 'output_text', text: 'pong' }],
                    },
                  ],
                },
              }
            : {
                type: 'response.completed',
                response: {
                  status: 'completed',
                  output: [
                    {
                      ...call,
                      ...(outcome === 'invalid-arguments'
                        ? { arguments: 'not-json' }
                        : {}),
                      ...(outcome === 'missing-call-id'
                        ? { call_id: undefined }
                        : {}),
                    },
                  ],
                },
              };
          const stream = `: keepalive\r\n\r\ndata: ${JSON.stringify(event)}\r\n\r\n`;
          response.write(stream.slice(0, 37));
          setImmediate(() => response.end(stream.slice(37)));
        });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      try {
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('No TCP address');
        const result = await qualifyProviderModel({
          provider: 'openai-compatible-native',
          modelId: 'openai-compatible-native/custom/model',
          baseUrl: `http://127.0.0.1:${address.port}/prefix/v1`,
        });
        expect(result.success).toBe(outcome === 'completed');
        expect(requests[0]).toMatchObject({
          url: '/prefix/v1/responses',
          body: {
            model: 'custom/model',
            store: false,
            stream: true,
            tool_choice: 'required',
          },
        });
        expect(
          requests.every((request) => request.authorization === undefined),
        ).toBe(true);
        if (!['invalid-arguments', 'missing-call-id'].includes(outcome)) {
          expect(requests).toHaveLength(2);
          expect(requests[1]?.body).toMatchObject({
            input: expect.arrayContaining([
              call,
              {
                type: 'function_call_output',
                call_id: 'call_ping',
                output: 'pong',
              },
            ]),
            tool_choice: 'none',
          });
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );

  it('qualifies a provider model with a streaming tool request', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_ping","function":{"name":"ping","arguments":"{}"}}]}}]}\n\n',
        {
          headers: { 'content-type': 'text/event-stream' },
        },
      ),
    );

    fetchMock.mockResolvedValueOnce(
      new Response(
        'data: {"choices":[{"delta":{"content":"pong"},"finish_reason":"stop"}]}\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    );

    await expect(
      qualifyProviderModel({
        provider: 'vllm',
        baseUrl: 'https://vllm.example/v1',
        apiKey: 'submitted-key',
        modelId: 'vllm/qwen3',
      }),
    ).resolves.toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://vllm.example/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer submitted-key',
        }),
        body: expect.stringContaining('"stream":true'),
      }),
    );
  });

  it('rejects streams that do not call the qualification tool', async () => {
    fetchMock.mockResolvedValue(
      new Response('data: {"choices":[{"delta":{"content":"pong"}}]}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
    );

    await expect(
      qualifyProviderModel({
        provider: 'ollama',
        baseUrl: 'http://ollama.example',
        modelId: 'ollama/qwen3',
      }),
    ).resolves.toEqual({
      success: false,
      error: expect.stringContaining('did not call the required tool'),
    });
  });

  it('returns provider compatibility details from qualification errors', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ detail: 'tools are unsupported for this model' }),
        {
          status: 422,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    await expect(
      qualifyProviderModel({
        provider: 'vllm',
        baseUrl: 'https://vllm.example',
        modelId: 'vllm/qwen3',
      }),
    ).resolves.toEqual({
      success: false,
      error: expect.stringContaining('tools are unsupported for this model'),
    });
  });

  it.each([
    'data: {"choices":[{"delta":{"content":"ping","tool_calls":[{"function":{"name":"wrong_tool"}}]}}]}\n\n',
    'data: {"error":{"tool_calls":"ping"}}\n\n',
    ': {"choices":[{"delta":{"tool_calls":[{"function":{"name":"ping"}}]}}]}\n\n',
    'data: malformed "tool_calls" "ping"\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"pi"}},{"index":1,"function":{"name":"ng"}}]}}]}\n\n',
  ])('rejects a stream without an actual ping tool call: %s', async (body) => {
    fetchMock.mockResolvedValue(
      new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    );

    await expect(
      qualifyProviderModel({
        provider: 'openai-compatible',
        baseUrl: 'http://provider.example/v1',
        modelId: 'test-model',
      }),
    ).resolves.toMatchObject({ success: false });
  });

  it('validates tool calls over HTTP, including fragmented names and multiline SSE data', async () => {
    vi.unstubAllGlobals();
    let body = 'data: {"error":{"tool_calls":"ping"}}\r\n\r\n';
    const requests: Array<{ url?: string; method?: string; body: unknown }> =
      [];
    const server = createServer((request, response) => {
      let requestBody = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        requestBody += chunk;
      });
      request.on('end', () => {
        const parsed = JSON.parse(requestBody);
        requests.push({
          url: request.url,
          method: request.method,
          body: JSON.parse(requestBody),
        });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const stream = parsed.messages?.some(
          (message: { role: string }) => message.role === 'tool',
        )
          ? 'data: {"choices":[{"delta":{"content":"pong"},"finish_reason":"stop"}]}\r\n\r\n'
          : body;
        response.write(stream.slice(0, 17));
        setImmediate(() => response.end(stream.slice(17)));
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('No TCP address');
      const qualify = () =>
        qualifyProviderModel({
          provider: 'openai-compatible',
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          modelId: 'test-model',
        });

      await expect(qualify()).resolves.toMatchObject({ success: false });
      body = [
        ': keepalive\r\n\r\n',
        'data: {"choices":[\r\ndata: {"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_ping","function":{"name":"pi","arguments":"{}"}}]}}]}\r\n\r\n',
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"ng"}}]}}]}\r\n\r\n',
        'data: [DONE]\r\n\r\n',
      ].join('');
      await expect(qualify()).resolves.toEqual({ success: true });
      expect(requests).toEqual([
        {
          url: '/v1/chat/completions',
          method: 'POST',
          body: expect.objectContaining({ tool_choice: 'required' }),
        },
        {
          url: '/v1/chat/completions',
          method: 'POST',
          body: expect.objectContaining({ tool_choice: 'required' }),
        },
        {
          url: '/v1/chat/completions',
          method: 'POST',
          body: expect.objectContaining({
            messages: expect.arrayContaining([
              { role: 'tool', tool_call_id: 'call_ping', content: 'pong' },
            ]),
          }),
        },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
