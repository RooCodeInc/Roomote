import { Hono } from 'hono';
import type { AuthTokenContext, RunTokenContext } from '@roomote/types';

import type { Variables } from '../../../types';

const {
  mockFindTaskRun,
  mockResolveModelProviderEnvValue,
  mockGetFreshChatGptAccessToken,
  mockGetGitHubCopilotAccessToken,
  mockRecordLlmUsage,
} = vi.hoisted(() => ({
  mockFindTaskRun: vi.fn(),
  mockResolveModelProviderEnvValue: vi.fn(),
  mockGetFreshChatGptAccessToken: vi.fn(),
  mockGetGitHubCopilotAccessToken: vi.fn(),
  mockRecordLlmUsage: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      taskRuns: { findFirst: mockFindTaskRun },
    },
  },
  taskRuns: { id: 'id' },
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  resolveModelProviderEnvValue: mockResolveModelProviderEnvValue,
  getFreshChatGptAccessToken: mockGetFreshChatGptAccessToken,
  getGitHubCopilotAccessToken: mockGetGitHubCopilotAccessToken,
}));

vi.mock('@roomote/sdk/server', () => ({
  recordLlmUsage: mockRecordLlmUsage,
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
  return appRequest(
    app,
    path,
    { model: 'claude-sonnet-5', max_tokens: 16 },
    headers,
  );
}

async function appRequest(
  app: Hono<{ Variables: Variables }>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer run-token-value',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('inference gateway', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mockFindTaskRun.mockResolvedValue({ id: 42 });
    mockGetGitHubCopilotAccessToken.mockResolvedValue(null);
    mockResolveModelProviderEnvValue.mockImplementation(
      async (names: string | readonly string[]) => {
        const nameList = typeof names === 'string' ? [names] : names;

        // Region lookups resolve separately from API keys.
        return nameList.includes('AWS_REGION')
          ? undefined
          : 'provider-secret-key';
      },
    );
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

  it('rejects provider account paths nested below former inference prefixes', async () => {
    const fetchMock = stubUpstreamFetch();
    const app = createApp(createRunToken());

    const [anthropicResponse, openRouterResponse] = await Promise.all([
      postMessages(app, '/api/inference/anthropic/v1/messages/batches'),
      postMessages(app, '/api/inference/openrouter/v1/key'),
    ]);

    expect(anthropicResponse.status).toBe(403);
    expect(openRouterResponse.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects encoded-slash and dot-segment traversal under nested-path providers', async () => {
    const fetchMock = stubUpstreamFetch();
    const app = createApp(createRunToken());

    const [googleEncoded, googleDots, vercelEncoded] = await Promise.all([
      postMessages(
        app,
        '/api/inference/google/v1beta/models/..%2F..%2Fv1internal',
      ),
      postMessages(app, '/api/inference/google/v1beta/models/../admin'),
      postMessages(app, '/api/inference/vercel/v1/ai/..%2Fadmin'),
    ]);

    expect(googleEncoded.status).toBe(403);
    expect(googleDots.status).toBe(403);
    expect(vercelEncoded.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('proxies OpenAI-compatible aggregator providers with bearer auth', async () => {
    const app = createApp(createRunToken());

    const cases: Array<[string, string]> = [
      ['requesty', 'https://router.requesty.ai/v1/chat/completions'],
      ['baseten', 'https://inference.baseten.co/v1/chat/completions'],
      ['togetherai', 'https://api.together.xyz/v1/chat/completions'],
      ['moonshotai', 'https://api.moonshot.ai/v1/chat/completions'],
      ['opencode', 'https://opencode.ai/zen/v1/chat/completions'],
      ['xai', 'https://api.x.ai/v1/chat/completions'],
    ];

    for (const [providerId, expectedUrl] of cases) {
      // A Response body can only be consumed once, so re-stub per provider.
      const fetchMock = stubUpstreamFetch();

      const response = await postMessages(
        app,
        `/api/inference/${providerId}/v1/chat/completions`,
      );

      expect(response.status).toBe(200);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(expectedUrl);
      expect(new Headers(init.headers).get('authorization')).toBe(
        'Bearer provider-secret-key',
      );
    }
  });

  it('proxies MiniMax through its Anthropic-compatible endpoint', async () => {
    const fetchMock = stubUpstreamFetch();
    const response = await postMessages(
      createApp(createRunToken()),
      '/api/inference/minimax/v1/messages',
    );

    expect(response.status).toBe(200);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.minimax.io/anthropic/v1/messages');
    expect(new Headers(init.headers).get('x-api-key')).toBe(
      'provider-secret-key',
    );
  });

  it('proxies Kimi for Coding through its Anthropic-compatible endpoint', async () => {
    const fetchMock = stubUpstreamFetch();
    const response = await postMessages(
      createApp(createRunToken()),
      '/api/inference/kimi-for-coding/v1/messages',
    );

    expect(response.status).toBe(200);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.kimi.com/coding/v1/messages');
    expect(new Headers(init.headers).get('x-api-key')).toBe(
      'provider-secret-key',
    );
  });

  it('proxies GitHub Copilot without a /v1 base-path suffix', async () => {
    mockGetGitHubCopilotAccessToken.mockResolvedValue('github-oauth-token');
    const fetchMock = stubUpstreamFetch();
    const response = await postMessages(
      createApp(createRunToken()),
      '/api/inference/github-copilot/chat/completions',
    );

    expect(response.status).toBe(200);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.githubcopilot.com/chat/completions');
    expect(new Headers(init.headers).get('authorization')).toBe(
      'Bearer github-oauth-token',
    );
  });

  it('proxies GitHub Copilot responses path', async () => {
    mockGetGitHubCopilotAccessToken.mockResolvedValue('github-oauth-token');
    const fetchMock = stubUpstreamFetch();
    const response = await postMessages(
      createApp(createRunToken()),
      '/api/inference/github-copilot/responses',
    );

    expect(response.status).toBe(200);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.githubcopilot.com/responses');
    expect(new Headers(init.headers).get('authorization')).toBe(
      'Bearer github-oauth-token',
    );
  });

  it('prefers the connected GitHub Copilot OAuth token and adds Copilot headers', async () => {
    mockGetGitHubCopilotAccessToken.mockResolvedValue('github-oauth-token');
    const fetchMock = stubUpstreamFetch();
    const response = await postMessages(
      createApp(createRunToken()),
      '/api/inference/github-copilot/chat/completions',
      { 'x-initiator': 'attacker' },
    );

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer github-oauth-token');
    expect(headers.get('openai-intent')).toBe('conversation-edits');
    expect(headers.get('x-initiator')).toBe('user');
  });

  it('preserves OpenCode agent-initiated Copilot classification', async () => {
    mockGetGitHubCopilotAccessToken.mockResolvedValue('github-oauth-token');
    const fetchMock = stubUpstreamFetch();
    await postMessages(
      createApp(createRunToken()),
      '/api/inference/github-copilot/chat/completions',
      { 'x-initiator': 'agent' },
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get('x-initiator')).toBe('agent');
  });

  it('sets Copilot-Vision-Request when the body carries image content', async () => {
    mockGetGitHubCopilotAccessToken.mockResolvedValue('github-oauth-token');
    const fetchMock = stubUpstreamFetch();
    const response = await appRequest(
      createApp(createRunToken()),
      '/api/inference/github-copilot/chat/completions',
      {
        model: 'claude-sonnet-5',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is in this image?' },
              {
                type: 'image_url',
                image_url: { url: 'data:image/png;base64,abc' },
              },
            ],
          },
        ],
      },
    );

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get('copilot-vision-request')).toBe(
      'true',
    );
  });

  it('does not set Copilot-Vision-Request for text-only Copilot requests', async () => {
    mockGetGitHubCopilotAccessToken.mockResolvedValue('github-oauth-token');
    const fetchMock = stubUpstreamFetch();
    await postMessages(
      createApp(createRunToken()),
      '/api/inference/github-copilot/chat/completions',
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get('copilot-vision-request')).toBeNull();
  });

  it('ignores client-supplied Copilot-Vision-Request when the body is text-only', async () => {
    mockGetGitHubCopilotAccessToken.mockResolvedValue('github-oauth-token');
    const fetchMock = stubUpstreamFetch();
    await postMessages(
      createApp(createRunToken()),
      '/api/inference/github-copilot/chat/completions',
      { 'copilot-vision-request': 'true' },
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get('copilot-vision-request')).toBeNull();
  });

  it('allows nested paths under the Vercel AI Gateway protocol base', async () => {
    const fetchMock = stubUpstreamFetch();
    const response = await postMessages(
      createApp(createRunToken()),
      '/api/inference/vercel/v1/ai/language-model',
    );

    expect(response.status).toBe(200);

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://ai-gateway.vercel.sh/v1/ai/language-model');
  });

  it('substitutes the default region for Bedrock upstreams', async () => {
    const fetchMock = stubUpstreamFetch();
    const response = await postMessages(
      createApp(createRunToken()),
      '/api/inference/bedrock-mantle/v1/messages',
    );

    expect(response.status).toBe(200);
    expect(mockResolveModelProviderEnvValue).toHaveBeenCalledWith([
      'AWS_BEARER_TOKEN_BEDROCK',
    ]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages',
    );
    expect(new Headers(init.headers).get('x-api-key')).toBe(
      'provider-secret-key',
    );
  });

  it('substitutes a configured region for Bedrock upstreams', async () => {
    const fetchMock = stubUpstreamFetch();
    mockResolveModelProviderEnvValue.mockImplementation(
      async (names: string | readonly string[]) => {
        const nameList = typeof names === 'string' ? [names] : names;

        return nameList.includes('AWS_REGION')
          ? 'eu-west-1'
          : 'provider-secret-key';
      },
    );

    const response = await postMessages(
      createApp(createRunToken()),
      '/api/inference/bedrock-mantle/v1/messages',
    );

    expect(response.status).toBe(200);

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(
      'https://bedrock-mantle.eu-west-1.api.aws/anthropic/v1/messages',
    );
  });

  it('proxies a configured LiteLLM endpoint with its optional key', async () => {
    const fetchMock = stubUpstreamFetch();
    mockResolveModelProviderEnvValue.mockImplementation(
      async (names: string | readonly string[]) => {
        const nameList = typeof names === 'string' ? [names] : names;

        if (nameList.includes('LITELLM_BASE_URL')) {
          return 'http://litellm.internal:4000/v1/';
        }

        return nameList.includes('LITELLM_API_KEY') ? 'litellm-key' : undefined;
      },
    );

    const response = await postMessages(
      createApp(createRunToken()),
      '/api/inference/litellm/v1/chat/completions',
    );

    expect(response.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://litellm.internal:4000/v1/chat/completions');
    expect(new Headers(init.headers).get('authorization')).toBe(
      'Bearer litellm-key',
    );
  });

  it('records a positive LiteLLM response cost without delaying the proxy', async () => {
    stubUpstreamFetch(
      new Response('data: [DONE]\n\n', {
        headers: {
          'content-type': 'text/event-stream',
          'x-litellm-response-cost': '0.000321',
          'x-litellm-model-group': 'coding',
        },
      }),
    );
    mockFindTaskRun.mockResolvedValue({ taskId: 'task-1' });
    mockResolveModelProviderEnvValue.mockImplementation(
      async (names: string | readonly string[]) => {
        const nameList = typeof names === 'string' ? [names] : names;
        return nameList.includes('LITELLM_BASE_URL')
          ? 'http://litellm.internal:4000'
          : 'litellm-key';
      },
    );

    const response = await postMessages(
      createApp(createRunToken()),
      '/api/inference/litellm/v1/chat/completions',
    );

    expect(response.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockRecordLlmUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          eventKey: expect.stringMatching(/^inference-gateway:/u),
          taskId: 'task-1',
          runId: 42,
          providerId: 'litellm',
          modelId: 'litellm/coding',
          costMicroUsd: 321,
          costSource: 'litellm_gateway',
        }),
      );
    });
  });

  it('proxies a configured Ollama endpoint without an API key', async () => {
    const fetchMock = stubUpstreamFetch();
    mockResolveModelProviderEnvValue.mockImplementation(
      async (names: string | readonly string[]) => {
        const nameList = typeof names === 'string' ? [names] : names;

        return nameList.includes('OLLAMA_BASE_URL')
          ? 'http://ollama.internal:11434'
          : undefined;
      },
    );

    const response = await postMessages(
      createApp(createRunToken()),
      '/api/inference/ollama/v1/chat/completions',
    );

    expect(response.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://ollama.internal:11434/v1/chat/completions');
    expect(new Headers(init.headers).get('authorization')).toBeNull();
  });

  it('rejects malformed dynamic upstream URLs before fetching', async () => {
    const fetchMock = stubUpstreamFetch();
    mockResolveModelProviderEnvValue.mockImplementation(
      async (names: string | readonly string[]) => {
        const nameList = typeof names === 'string' ? [names] : names;

        return nameList.includes('VLLM_BASE_URL')
          ? 'https://token@example.test?redirect=https://evil.test'
          : undefined;
      },
    );

    const response = await postMessages(
      createApp(createRunToken()),
      '/api/inference/vllm/v1/chat/completions',
    );

    expect(response.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects invalid Bedrock regions before building the upstream URL', async () => {
    const fetchMock = stubUpstreamFetch();
    mockResolveModelProviderEnvValue.mockImplementation(
      async (names: string | readonly string[]) => {
        const nameList = typeof names === 'string' ? [names] : names;

        return nameList.includes('AWS_REGION')
          ? 'https://evil.example.com/'
          : 'provider-secret-key';
      },
    );

    const response = await postMessages(
      createApp(createRunToken()),
      '/api/inference/bedrock-mantle/v1/messages',
    );

    expect(response.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('ChatGPT subscription (chatgpt-oauth strategy)', () => {
    async function postChatGpt(
      app: Hono<{ Variables: Variables }>,
      path = '/api/inference/openai-chatgpt/v1/responses',
      headers: Record<string, string> = {},
    ) {
      return app.request(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer run-token-value',
          ...headers,
        },
        body: JSON.stringify({ model: 'gpt-5-codex', input: 'hi' }),
      });
    }

    it('mints a token, rewrites to the Codex backend, and injects account id', async () => {
      const fetchMock = stubUpstreamFetch();
      mockGetFreshChatGptAccessToken.mockResolvedValue({
        access: 'oauth-access-token',
        refresh: 'oauth-refresh',
        expires: Date.now() + 3_600_000,
        accountId: 'acct_123',
      });

      const response = await postChatGpt(createApp(createRunToken()));

      expect(response.status).toBe(200);
      // The API key resolver must not be consulted for OAuth providers.
      expect(mockResolveModelProviderEnvValue).not.toHaveBeenCalled();

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');

      const headers = new Headers(init.headers);
      expect(headers.get('authorization')).toBe('Bearer oauth-access-token');
      expect(headers.get('ChatGPT-Account-Id')).toBe('acct_123');
    });

    it('strips the run token and any smuggled account id from the sandbox', async () => {
      const fetchMock = stubUpstreamFetch();
      mockGetFreshChatGptAccessToken.mockResolvedValue({
        access: 'oauth-access-token',
        refresh: 'oauth-refresh',
        expires: Date.now() + 3_600_000,
        accountId: 'acct_real',
      });

      await postChatGpt(createApp(createRunToken()), undefined, {
        'chatgpt-account-id': 'acct_attacker',
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = new Headers(init.headers);
      expect(headers.get('ChatGPT-Account-Id')).toBe('acct_real');
      expect(headers.get('authorization')).toBe('Bearer oauth-access-token');
    });

    it('returns 404 when no ChatGPT subscription is connected', async () => {
      const fetchMock = stubUpstreamFetch();
      mockGetFreshChatGptAccessToken.mockResolvedValue(null);

      const response = await postChatGpt(createApp(createRunToken()));

      expect(response.status).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects non-inference paths on the ChatGPT segment', async () => {
      const fetchMock = stubUpstreamFetch();
      const response = await postChatGpt(
        createApp(createRunToken()),
        '/api/inference/openai-chatgpt/v1/account',
      );

      expect(response.status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    });
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
    expect(mockResolveModelProviderEnvValue).toHaveBeenCalledWith([
      'ANTHROPIC_API_KEY',
    ]);
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
    expect(mockResolveModelProviderEnvValue).toHaveBeenCalledWith([
      'OPENROUTER_API_KEY',
    ]);

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
    expect(mockResolveModelProviderEnvValue).toHaveBeenCalledWith([
      'GOOGLE_GENERATIVE_AI_API_KEY',
      'GEMINI_API_KEY',
    ]);
  });

  it('streams the upstream response body and status through', async () => {
    const upstreamBody = 'event: message_start\ndata: {}\n\n';
    stubUpstreamFetch(
      new Response(upstreamBody, {
        status: 200,
        headers: {
          'cache-control': 'no-cache',
          'content-type': 'text/event-stream',
        },
      }),
    );

    const response = await postMessages(createApp(createRunToken()));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(
      'no-cache, no-transform',
    );
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(await response.text()).toBe(upstreamBody);
  });

  it('does not change cache directives on non-streaming responses', async () => {
    stubUpstreamFetch(
      new Response(JSON.stringify({ id: 'msg_1' }), {
        status: 200,
        headers: {
          'cache-control': 'private',
          'content-type': 'application/json',
        },
      }),
    );

    const response = await postMessages(createApp(createRunToken()));

    expect(response.headers.get('cache-control')).toBe('private');
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
