import {
  buildInferenceGatewayOpenCodeBaseUrl,
  buildInferenceGatewayUrl,
  CHATGPT_GATEWAY_PROVIDER_ID,
  getInferenceGatewayProvider,
  getInferenceGatewayProviderByEnvVarName,
  INFERENCE_GATEWAY_IDENTITY_PATTERN,
  INFERENCE_GATEWAY_PROVIDER_ENV_VAR_NAMES,
  INFERENCE_GATEWAY_PROVIDERS,
  isInferenceGatewayCoveredEnvVar,
  parseInferenceGatewayKeys,
  rewriteCloudflareAiGatewayRequestBody,
  toCloudflareAiGatewayUpstreamModelId,
} from '../inference-gateway';
import { getSetupModelProvider } from '../model-provider-config';

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

  it('registers OpenCode Go with its subscription endpoint and API key', () => {
    const provider = getInferenceGatewayProvider('opencode-go');

    expect(provider).toMatchObject({
      envVarNames: ['OPENCODE_GO_API_KEY'],
      upstreamBaseUrl: 'https://opencode.ai/zen/go',
      authHeader: { name: 'authorization', scheme: 'bearer' },
      openCodeBaseUrlSuffix: '/v1',
    });
    expect(provider?.allowedPaths).toEqual(
      expect.arrayContaining([
        '/v1/chat/completions',
        '/v1/responses',
        '/v1/messages',
      ]),
    );
    expect(
      buildInferenceGatewayOpenCodeBaseUrl(
        'https://api.example.com/api/inference',
        provider!,
      ),
    ).toBe('https://api.example.com/api/inference/opencode-go/v1');
    expect(
      getInferenceGatewayProviderByEnvVarName('OPENCODE_GO_API_KEY')?.id,
    ).toBe('opencode-go');
  });

  it('registers native Amazon Bedrock with its regional runtime endpoint', () => {
    const provider = getInferenceGatewayProvider('amazon-bedrock');

    expect(provider).toMatchObject({
      envVarNames: ['AWS_BEARER_TOKEN_BEDROCK'],
      upstreamBaseUrl: 'https://bedrock-runtime.{region}.amazonaws.com',
      region: { envVarName: 'AWS_REGION', default: 'us-east-1' },
      authHeader: { name: 'authorization', scheme: 'bearer' },
      allowedPaths: ['/model'],
      allowNestedPaths: true,
      openCodeBaseUrlSuffix: '',
    });
    expect(
      buildInferenceGatewayOpenCodeBaseUrl(
        'https://api.example.com/api/inference',
        provider!,
      ),
    ).toBe('https://api.example.com/api/inference/amazon-bedrock');
  });

  it.each([
    [
      'azure',
      'AZURE_API_KEY',
      'AZURE_RESOURCE_NAME',
      'https://{resource}.openai.azure.com/openai',
    ],
    [
      'azure-cognitive-services',
      'AZURE_COGNITIVE_SERVICES_API_KEY',
      'AZURE_COGNITIVE_SERVICES_RESOURCE_NAME',
      'https://{resource}.cognitiveservices.azure.com/openai',
    ],
  ] as const)(
    'registers %s with a resource-templated Azure upstream',
    (providerId, apiKeyEnvVarName, resourceEnvVarName, upstreamBaseUrl) => {
      const provider = getInferenceGatewayProvider(providerId);

      expect(provider).toMatchObject({
        envVarNames: [apiKeyEnvVarName],
        upstreamBaseUrl,
        resource: { envVarName: resourceEnvVarName },
        authHeader: { name: 'api-key' },
        openCodeBaseUrlSuffix: '',
      });
      expect(provider?.allowedPaths).toEqual(
        expect.arrayContaining(['/v1/chat/completions', '/v1/responses']),
      );
      expect(
        getInferenceGatewayProviderByEnvVarName(apiKeyEnvVarName)?.id,
      ).toBe(providerId);
      expect(
        buildInferenceGatewayOpenCodeBaseUrl(
          'https://api.example.com/api/inference',
          provider!,
        ),
      ).toBe(`https://api.example.com/api/inference/${providerId}`);
    },
  );

  it('registers Z.AI providers with v4 bases and empty OpenCode suffix', () => {
    const zai = getInferenceGatewayProvider('zai');
    expect(zai).toMatchObject({
      envVarNames: ['ZAI_API_KEY'],
      openCodeBaseUrlSuffix: '',
      region: {
        envVarName: 'ZAI_REGION',
        default: 'global',
        baseUrls: {
          global: 'https://api.z.ai/api/paas/v4',
          china: 'https://open.bigmodel.cn/api/paas/v4',
        },
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

  it('registers xAI with the hybrid xai-oauth strategy and API host', () => {
    const provider = getInferenceGatewayProvider('xai');
    expect(provider).toMatchObject({
      authStrategy: 'xai-oauth',
      envVarNames: ['XAI_API_KEY'],
      upstreamBaseUrl: 'https://api.x.ai',
      openCodeBaseUrlSuffix: '/v1',
    });
    expect(provider?.allowedPaths).toEqual(
      expect.arrayContaining(['/v1/chat/completions', '/v1/responses']),
    );
  });

  it('offers exactly the regions its gateway providers hold base URLs for', () => {
    const regionProviders = INFERENCE_GATEWAY_PROVIDERS.filter(
      (provider) => provider.region?.baseUrls,
    );

    expect(regionProviders.map((provider) => provider.id)).toEqual([
      'zai',
      'zai-coding-plan',
    ]);

    for (const provider of regionProviders) {
      const regions = Object.keys(provider.region!.baseUrls!);

      expect(regions).toContain(provider.region!.default);

      const field = (
        getSetupModelProvider(provider.id).additionalEnvFields ?? []
      ).find((entry) => entry.envVarName === provider.region!.envVarName);

      expect(field?.options?.map((option) => option.value)).toEqual(regions);
    }
  });

  it('parses a comma-separated served-keys value', () => {
    expect(
      parseInferenceGatewayKeys('ANTHROPIC_API_KEY, OPENROUTER_API_KEY'),
    ).toEqual(['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']);
    expect(parseInferenceGatewayKeys('')).toEqual([]);
    expect(parseInferenceGatewayKeys(undefined)).toEqual([]);
  });

  it('registers Cloudflare AI Gateway with account URL templating and a required gateway header', () => {
    const provider = getInferenceGatewayProvider('cloudflare-ai-gateway');

    expect(provider).toMatchObject({
      envVarNames: ['CLOUDFLARE_AI_GATEWAY_API_TOKEN'],
      upstreamBaseUrl:
        'https://api.cloudflare.com/client/v4/accounts/{resource}/ai',
      resource: { envVarName: 'CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID' },
      authHeader: { name: 'authorization', scheme: 'bearer' },
      requiredHeaders: [
        {
          envVarName: 'CLOUDFLARE_AI_GATEWAY_ID',
          headerName: 'cf-aig-gateway-id',
        },
      ],
      openCodeNpm: '@ai-sdk/openai-compatible',
      openCodeBaseUrlSuffix: '/v1',
    });
    expect(provider?.allowedPaths).toEqual(
      expect.arrayContaining([
        '/v1/chat/completions',
        '/v1/embeddings',
        '/v1/models',
      ]),
    );
    expect(
      getInferenceGatewayProviderByEnvVarName('CLOUDFLARE_AI_GATEWAY_API_TOKEN')
        ?.id,
    ).toBe('cloudflare-ai-gateway');
    expect(
      buildInferenceGatewayOpenCodeBaseUrl(
        'https://api.example.com/api/inference',
        provider!,
      ),
    ).toBe('https://api.example.com/api/inference/cloudflare-ai-gateway/v1');
  });

  it('registers Cloudflare Workers AI with account URL templating and no gateway id', () => {
    const provider = getInferenceGatewayProvider('cloudflare-workers-ai');

    expect(provider).toMatchObject({
      envVarNames: ['CLOUDFLARE_WORKERS_AI_API_TOKEN'],
      upstreamBaseUrl:
        'https://api.cloudflare.com/client/v4/accounts/{resource}/ai',
      resource: { envVarName: 'CLOUDFLARE_WORKERS_AI_ACCOUNT_ID' },
      authHeader: { name: 'authorization', scheme: 'bearer' },
      openCodeNpm: '@ai-sdk/openai-compatible',
      openCodeBaseUrlSuffix: '/v1',
    });
    expect(provider?.requiredHeaders).toBeUndefined();
    expect(provider?.allowedPaths).toEqual(
      expect.arrayContaining([
        '/v1/chat/completions',
        '/v1/embeddings',
        '/v1/responses',
      ]),
    );
    expect(
      getInferenceGatewayProviderByEnvVarName('CLOUDFLARE_WORKERS_AI_API_TOKEN')
        ?.id,
    ).toBe('cloudflare-workers-ai');
    expect(
      buildInferenceGatewayOpenCodeBaseUrl(
        'https://api.example.com/api/inference',
        provider!,
      ),
    ).toBe('https://api.example.com/api/inference/cloudflare-workers-ai/v1');
  });

  it('accepts underscore gateway ids and rejects header-unsafe values', () => {
    expect(INFERENCE_GATEWAY_IDENTITY_PATTERN.test('default')).toBe(true);
    expect(INFERENCE_GATEWAY_IDENTITY_PATTERN.test('my_gateway')).toBe(true);
    expect(INFERENCE_GATEWAY_IDENTITY_PATTERN.test('my-gateway')).toBe(true);
    expect(INFERENCE_GATEWAY_IDENTITY_PATTERN.test('my gateway')).toBe(false);
    expect(INFERENCE_GATEWAY_IDENTITY_PATTERN.test('gw\nid')).toBe(false);
  });

  it('strips the models.dev workers-ai namespace before /ai/v1', () => {
    expect(
      toCloudflareAiGatewayUpstreamModelId('workers-ai/@cf/zai-org/glm-5.2'),
    ).toBe('@cf/zai-org/glm-5.2');
    expect(toCloudflareAiGatewayUpstreamModelId('openai/gpt-5.6-terra')).toBe(
      'openai/gpt-5.6-terra',
    );
    expect(
      rewriteCloudflareAiGatewayRequestBody(
        JSON.stringify({
          model: 'workers-ai/@cf/zai-org/glm-5.2',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ),
    ).toBe(
      JSON.stringify({
        model: '@cf/zai-org/glm-5.2',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
  });
});
