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
      models: [{ modelId: 'vllm/qwen3' }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://vllm.example/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer submitted-key' },
      }),
    );
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

  it('qualifies a provider model with a streaming tool request', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        'data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"ping"}}]}}]}\n\n',
        {
          headers: { 'content-type': 'text/event-stream' },
        },
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
});
