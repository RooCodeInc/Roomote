import { getSetupModelProvider } from '@roomote/types';

const { mockGetPersistedEnvironmentVariableValues } = vi.hoisted(() => ({
  mockGetPersistedEnvironmentVariableValues: vi.fn(),
}));

vi.mock('../environment-variables', () => ({
  getPersistedEnvironmentVariableValues:
    mockGetPersistedEnvironmentVariableValues,
}));

import {
  assertModelProviderApiKeyAuthenticates,
  canValidateModelProviderApiKey,
  validateModelProviderApiKey,
} from './provider-credential-check';

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function buildFetch(response: Response | Error) {
  return vi.fn(async () => {
    if (response instanceof Error) {
      throw response;
    }

    return response;
  }) as unknown as typeof fetch;
}

function getRequest(fetchImpl: typeof fetch) {
  const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
    .calls[0] as [string, RequestInit];

  return { url, headers: init.headers as Record<string, string> };
}

describe('validateModelProviderApiKey', () => {
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPersistedEnvironmentVariableValues.mockResolvedValue({});
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (originalAnthropicKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    }
  });

  it('probes Anthropic with the key and the version header', async () => {
    const fetchImpl = buildFetch(jsonResponse(200, { data: [] }));

    await expect(
      validateModelProviderApiKey({
        provider: getSetupModelProvider('anthropic'),
        apiKey: 'sk-ant-good',
        fetchImpl,
      }),
    ).resolves.toEqual({ status: 'valid' });

    const request = getRequest(fetchImpl);
    expect(request.url).toBe('https://api.anthropic.com/v1/models?limit=1');
    expect(request.headers['x-api-key']).toBe('sk-ant-good');
    expect(request.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('sends bearer keys to the provider upstream base', async () => {
    const fetchImpl = buildFetch(jsonResponse(200, { data: [] }));

    await validateModelProviderApiKey({
      provider: getSetupModelProvider('openai'),
      apiKey: 'sk-openai',
      fetchImpl,
    });

    const request = getRequest(fetchImpl);
    expect(request.url).toBe('https://api.openai.com/v1/models');
    expect(request.headers.authorization).toBe('Bearer sk-openai');
  });

  it('probes an OpenRouter endpoint that actually requires the key', async () => {
    const fetchImpl = buildFetch(jsonResponse(200, { data: {} }));

    await validateModelProviderApiKey({
      provider: getSetupModelProvider('openrouter'),
      apiKey: 'sk-or-good',
      fetchImpl,
    });

    // `/api/v1/models` is public, so it would call any string a valid key.
    expect(getRequest(fetchImpl).url).toBe('https://openrouter.ai/api/v1/key');
  });

  it('sends the Google key in its own header', async () => {
    const fetchImpl = buildFetch(jsonResponse(200, { models: [] }));

    await validateModelProviderApiKey({
      provider: getSetupModelProvider('google'),
      apiKey: 'gemini-good',
      fetchImpl,
    });

    const request = getRequest(fetchImpl);
    expect(request.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models',
    );
    expect(request.headers['x-goog-api-key']).toBe('gemini-good');
  });

  it('reports a rejected key with the provider message and the field', async () => {
    const result = await validateModelProviderApiKey({
      provider: getSetupModelProvider('anthropic'),
      apiKey: 'sk-ant-bad',
      fetchImpl: buildFetch(
        jsonResponse(401, {
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid x-api-key' },
        }),
      ),
    });

    expect(result).toEqual({
      status: 'invalid',
      error:
        'Anthropic rejected the API key (ANTHROPIC_API_KEY), status 401: “invalid x-api-key” Check the value and save it again.',
    });
  });

  it('treats a Google 400 as a rejected key', async () => {
    const result = await validateModelProviderApiKey({
      provider: getSetupModelProvider('google'),
      apiKey: 'gemini-bad',
      fetchImpl: buildFetch(
        jsonResponse(400, {
          error: { message: 'API key not valid. Please pass a valid API key.' },
        }),
      ),
    });

    expect(result.status).toBe('invalid');
    expect(result.status === 'invalid' && result.error).toContain(
      'API key not valid.',
    );
  });

  it('treats an xAI 400 as a rejected key', async () => {
    const result = await validateModelProviderApiKey({
      provider: getSetupModelProvider('xai'),
      apiKey: 'xai-bad',
      fetchImpl: buildFetch(
        jsonResponse(400, {
          code: 'invalid-argument',
          error: 'Incorrect API key provided.',
        }),
      ),
    });

    expect(result).toEqual({
      status: 'invalid',
      error:
        'xAI rejected the API key (XAI_API_KEY), status 400: “Incorrect API key provided.” Check the value and save it again.',
    });
  });

  it('does not call a rate limited provider a rejection', async () => {
    const result = await validateModelProviderApiKey({
      provider: getSetupModelProvider('openai'),
      apiKey: 'sk-openai',
      fetchImpl: buildFetch(jsonResponse(429, { error: { message: 'slow' } })),
    });

    expect(result.status).toBe('unknown');
  });

  it('does not call an unreachable provider a rejection', async () => {
    const result = await validateModelProviderApiKey({
      provider: getSetupModelProvider('openai'),
      apiKey: 'sk-openai',
      fetchImpl: buildFetch(new Error('connect ECONNREFUSED')),
    });

    expect(result.status).toBe('unknown');
    expect(result.status === 'unknown' && result.error).toContain(
      'connect ECONNREFUSED',
    );
  });

  it('leaves endpoint providers on their existing discovery path', async () => {
    const fetchImpl = buildFetch(jsonResponse(401, {}));

    expect(canValidateModelProviderApiKey('litellm')).toBe(false);
    await expect(
      validateModelProviderApiKey({
        provider: getSetupModelProvider('litellm'),
        apiKey: 'anything',
        fetchImpl,
      }),
    ).resolves.toEqual({ status: 'valid' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('assertModelProviderApiKeyAuthenticates', () => {
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPersistedEnvironmentVariableValues.mockResolvedValue({});
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();

    if (originalAnthropicKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    }
  });

  it('fails the save when the provider rejects the key', async () => {
    vi.stubGlobal(
      'fetch',
      buildFetch(
        jsonResponse(401, { error: { message: 'invalid x-api-key' } }),
      ),
    );

    await expect(
      assertModelProviderApiKeyAuthenticates({
        provider: getSetupModelProvider('anthropic'),
        apiKey: 'sk-ant-bad',
      }),
    ).rejects.toThrow('Anthropic rejected the API key');
  });

  it('allows the save when the provider could not be reached', async () => {
    vi.stubGlobal('fetch', buildFetch(new Error('network down')));

    await expect(
      assertModelProviderApiKeyAuthenticates({
        provider: getSetupModelProvider('anthropic'),
        apiKey: 'sk-ant-good',
      }),
    ).resolves.toBeUndefined();
  });

  it('validates the stored key when the form submits a blank field', async () => {
    const fetchImpl = buildFetch(jsonResponse(200, { data: [] }));
    vi.stubGlobal('fetch', fetchImpl);
    mockGetPersistedEnvironmentVariableValues.mockResolvedValue({
      ANTHROPIC_API_KEY: 'sk-ant-saved',
    });

    await assertModelProviderApiKeyAuthenticates({
      provider: getSetupModelProvider('anthropic'),
      apiKey: '',
    });

    expect(mockGetPersistedEnvironmentVariableValues).toHaveBeenCalledWith([
      'ANTHROPIC_API_KEY',
    ]);
    expect(getRequest(fetchImpl).headers['x-api-key']).toBe('sk-ant-saved');
  });

  it('leaves a missing key to the required-value check', async () => {
    const fetchImpl = buildFetch(jsonResponse(401, {}));
    vi.stubGlobal('fetch', fetchImpl);

    await expect(
      assertModelProviderApiKeyAuthenticates({
        provider: getSetupModelProvider('anthropic'),
      }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
