import {
  buildInferenceGatewayOpenCodeBaseUrl,
  buildInferenceGatewayUrl,
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

  it('parses a comma-separated served-keys value', () => {
    expect(
      parseInferenceGatewayKeys('ANTHROPIC_API_KEY, OPENROUTER_API_KEY'),
    ).toEqual(['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']);
    expect(parseInferenceGatewayKeys('')).toEqual([]);
    expect(parseInferenceGatewayKeys(undefined)).toEqual([]);
  });
});
