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
      expect(provider?.envVarNames).toContain(envVarName);
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
    expect(getInferenceGatewayProvider('litellm')).toMatchObject({
      upstreamBaseUrlEnvVarName: 'LITELLM_BASE_URL',
      optionalApiKey: true,
    });
    expect(getInferenceGatewayProvider('ollama')).toMatchObject({
      upstreamBaseUrlEnvVarName: 'OLLAMA_BASE_URL',
      envVarNames: [],
    });
    expect(getInferenceGatewayProvider('lmstudio')).toMatchObject({
      upstreamBaseUrlEnvVarName: 'LMSTUDIO_BASE_URL',
      optionalApiKey: true,
    });
  });

  it('parses a comma-separated served-keys value', () => {
    expect(
      parseInferenceGatewayKeys('ANTHROPIC_API_KEY, OPENROUTER_API_KEY'),
    ).toEqual(['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']);
    expect(parseInferenceGatewayKeys('')).toEqual([]);
    expect(parseInferenceGatewayKeys(undefined)).toEqual([]);
  });
});
