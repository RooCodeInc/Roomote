import {
  buildInferenceGatewayOpenCodeBaseUrl,
  buildInferenceGatewayUrl,
  CHATGPT_GATEWAY_PROVIDER_ID,
  getInferenceGatewayProvider,
  getInferenceGatewayProviderByEnvVarName,
  INFERENCE_GATEWAY_PROVIDER_ENV_VAR_NAMES,
  isInferenceGatewayCoveredEnvVar,
  parseInferenceGatewayKeys,
} from '../inference-gateway';

describe('inference gateway URL builders', () => {
  it('appends the gateway path to a platform URL', () => {
    expect(buildInferenceGatewayUrl('https://api.example.com')).toBe(
      'https://api.example.com/api/inference',
    );
  });

  it('strips trailing slashes before appending the gateway path', () => {
    expect(buildInferenceGatewayUrl('https://api.example.com///')).toBe(
      'https://api.example.com/api/inference',
    );
  });

  it('builds the OpenCode provider base URL with the provider id and suffix', () => {
    const provider = getInferenceGatewayProvider('anthropic');
    expect(provider).toBeDefined();
    expect(
      buildInferenceGatewayOpenCodeBaseUrl(
        'https://api.example.com/api/inference/',
        provider!,
      ),
    ).toBe('https://api.example.com/api/inference/anthropic/v1');
  });

  it('registers Kimi for Coding as an Anthropic-compatible gateway provider', () => {
    const provider = getInferenceGatewayProvider('kimi-for-coding');
    expect(provider).toMatchObject({
      envVarNames: ['KIMI_API_KEY'],
      upstreamBaseUrl: 'https://api.kimi.com/coding',
      authHeader: { name: 'x-api-key' },
      openCodeBaseUrlSuffix: '/v1',
    });
    expect(
      buildInferenceGatewayOpenCodeBaseUrl(
        'https://api.example.com/api/inference',
        provider!,
      ),
    ).toBe('https://api.example.com/api/inference/kimi-for-coding/v1');
    expect(getInferenceGatewayProviderByEnvVarName('KIMI_API_KEY')?.id).toBe(
      'kimi-for-coding',
    );
  });

  it('registers Z.AI providers with v4 bases and empty OpenCode suffix', () => {
    const zai = getInferenceGatewayProvider('zai');
    expect(zai).toMatchObject({
      envVarNames: ['ZAI_API_KEY'],
      openCodeBaseUrlSuffix: '',
      regionBaseUrls: {
        global: 'https://api.z.ai/api/paas/v4',
        china: 'https://open.bigmodel.cn/api/paas/v4',
      },
    });
    expect(zai?.allowedPaths).toContain('/chat/completions');
    expect(zai?.allowedPaths).not.toContain('/v1/chat/completions');
    expect(
      buildInferenceGatewayOpenCodeBaseUrl(
        'https://api.example.com/api/inference',
        zai!,
      ),
    ).toBe('https://api.example.com/api/inference/zai');
    expect(getInferenceGatewayProviderByEnvVarName('ZAI_API_KEY')?.id).toBe(
      'zai',
    );
    expect(
      getInferenceGatewayProviderByEnvVarName('ZAI_CODING_PLAN_API_KEY')?.id,
    ).toBe('zai-coding-plan');
  });

  it('exposes a chatgpt-oauth provider that collapses to the Codex backend', () => {
    const provider = getInferenceGatewayProvider(CHATGPT_GATEWAY_PROVIDER_ID);
    expect(provider?.authStrategy).toBe('chatgpt-oauth');
    // No env key: the gateway holds the OAuth record, so it must not appear in
    // the withheld-key set that the sandbox strips.
    expect(provider?.envVarNames).toEqual([]);
    expect(INFERENCE_GATEWAY_PROVIDER_ENV_VAR_NAMES).not.toContain(
      CHATGPT_GATEWAY_PROVIDER_ID,
    );
    expect(provider?.upstreamBaseUrl).toBe('https://chatgpt.com');
    expect(provider?.collapseToPath).toBe('/backend-api/codex/responses');
    expect(
      buildInferenceGatewayOpenCodeBaseUrl(
        'https://api.example.com/api/inference',
        provider!,
      ),
    ).toBe('https://api.example.com/api/inference/openai-chatgpt/v1');
  });
});

describe('inference gateway key lookups', () => {
  it('maps each covered env var name back to its provider', () => {
    for (const envVarName of INFERENCE_GATEWAY_PROVIDER_ENV_VAR_NAMES) {
      const provider = getInferenceGatewayProviderByEnvVarName(envVarName);
      expect(provider?.gatewayEnvVarNames ?? provider?.envVarNames).toContain(
        envVarName,
      );
      expect(isInferenceGatewayCoveredEnvVar(envVarName)).toBe(true);
    }
  });

  it('resolves the Gemini alias to the google provider', () => {
    expect(getInferenceGatewayProviderByEnvVarName('GEMINI_API_KEY')?.id).toBe(
      'google',
    );
    expect(
      getInferenceGatewayProviderByEnvVarName('GOOGLE_GENERATIVE_AI_API_KEY')
        ?.id,
    ).toBe('google');
  });

  it('does not cover Vertex or unknown keys', () => {
    expect(
      isInferenceGatewayCoveredEnvVar('GOOGLE_APPLICATION_CREDENTIALS'),
    ).toBe(false);
    expect(isInferenceGatewayCoveredEnvVar('SOME_OTHER_KEY')).toBe(false);
  });

  it('registers local OpenAI-compatible endpoint providers', () => {
    expect(getInferenceGatewayProvider('openai-compatible')).toMatchObject({
      upstreamBaseUrlEnvVarName: 'OPENAI_COMPATIBLE_BASE_URL',
      gatewayEnvVarNames: [
        'OPENAI_COMPATIBLE_BASE_URL',
        'OPENAI_COMPATIBLE_API_KEY',
      ],
    });
    expect(
      getInferenceGatewayProvider('openai-compatible-company-proxy'),
    ).toMatchObject({
      id: 'openai-compatible-company-proxy',
      upstreamBaseUrlEnvVarName: 'OPENAI_COMPATIBLE_COMPANY_PROXY_BASE_URL',
      gatewayEnvVarNames: [
        'OPENAI_COMPATIBLE_COMPANY_PROXY_BASE_URL',
        'OPENAI_COMPATIBLE_COMPANY_PROXY_API_KEY',
      ],
    });
    expect(
      getInferenceGatewayProviderByEnvVarName(
        'OPENAI_COMPATIBLE_COMPANY_PROXY_API_KEY',
      )?.id,
    ).toBe('openai-compatible-company-proxy');
    expect(getInferenceGatewayProvider('litellm')).toMatchObject({
      upstreamBaseUrlEnvVarName: 'LITELLM_BASE_URL',
      gatewayEnvVarNames: ['LITELLM_BASE_URL', 'LITELLM_API_KEY'],
    });
    expect(getInferenceGatewayProvider('ollama')).toMatchObject({
      upstreamBaseUrlEnvVarName: 'OLLAMA_BASE_URL',
      gatewayEnvVarNames: ['OLLAMA_BASE_URL'],
    });
    expect(getInferenceGatewayProvider('vllm')).toMatchObject({
      upstreamBaseUrlEnvVarName: 'VLLM_BASE_URL',
      gatewayEnvVarNames: ['VLLM_BASE_URL', 'VLLM_API_KEY'],
    });
  });

  it('registers GitHub Copilot with the models.dev base path layout', () => {
    const provider = getInferenceGatewayProvider('github-copilot');
    expect(provider).toMatchObject({
      authStrategy: 'github-copilot-oauth',
      envVarNames: [],
      upstreamBaseUrl: 'https://api.githubcopilot.com',
      openCodeBaseUrlSuffix: '',
    });
    expect(provider?.allowedPaths).toEqual(
      expect.arrayContaining(['/chat/completions', '/responses']),
    );
    expect(
      buildInferenceGatewayOpenCodeBaseUrl(
        'https://api.example.com/api/inference',
        provider!,
      ),
    ).toBe('https://api.example.com/api/inference/github-copilot');
  });

  it('parses a comma-separated served-keys value', () => {
    expect(
      parseInferenceGatewayKeys('ANTHROPIC_API_KEY, OPENROUTER_API_KEY'),
    ).toEqual(['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']);
    expect(parseInferenceGatewayKeys('')).toEqual([]);
    expect(parseInferenceGatewayKeys(undefined)).toEqual([]);
  });
});
