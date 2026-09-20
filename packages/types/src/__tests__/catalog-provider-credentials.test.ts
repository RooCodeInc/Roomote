import { describe, expect, it } from 'vitest';

import { mergeCatalogProviderCredentialConfig } from '../catalog-provider-credentials';

describe('mergeCatalogProviderCredentialConfig', () => {
  it('leaves the config untouched when no selected model uses these providers', () => {
    const providerConfig = { anthropic: { options: { timeout: 1 } } };

    expect(
      mergeCatalogProviderCredentialConfig(providerConfig, {}, [
        'anthropic/claude-sonnet-5',
        undefined,
        // Served by another provider; only the id prefix matters.
        'openrouter/z-ai/glm-5.3',
      ]),
    ).toBe(providerConfig);
  });

  it.each([
    ['zai/glm-5.3', 'zai', 'ZAI_API_KEY'],
    ['zai-coding-plan/glm-5.3', 'zai-coding-plan', 'ZAI_CODING_PLAN_API_KEY'],
    ['opencode-go/kimi-k3', 'opencode-go', 'OPENCODE_GO_API_KEY'],
    [
      'azure-cognitive-services/gpt-5.6-sol',
      'azure-cognitive-services',
      'AZURE_COGNITIVE_SERVICES_API_KEY',
    ],
  ])(
    'binds %s to the env var Roomote stores its key under',
    (modelId, providerId, envVarName) => {
      // OpenCode's catalog names a different env var for each of these, so
      // without the binding the request is sent with no key at all.
      const merged = mergeCatalogProviderCredentialConfig({}, {}, [modelId]);

      expect(merged).toEqual({
        [providerId]: { options: { apiKey: `{env:${envVarName}}` } },
      });
    },
  );

  it('keeps Azure AI Foundry off the Azure OpenAI key', () => {
    // Both use the Azure SDK, which reads AZURE_API_KEY by default, so an
    // unbound Foundry call would borrow the other provider's credential.
    const merged = mergeCatalogProviderCredentialConfig(
      {},
      { AZURE_API_KEY: 'azure-openai-key' },
      ['azure-cognitive-services/gpt-5.6-sol', 'azure/gpt-5.6-sol'],
    );

    expect(merged).toEqual({
      'azure-cognitive-services': {
        options: { apiKey: '{env:AZURE_COGNITIVE_SERVICES_API_KEY}' },
      },
    });
  });

  describe('a provider that accepts more than one key name (Google)', () => {
    it('binds the alias Roomote stores the key under, which the SDK does not read', () => {
      expect(
        mergeCatalogProviderCredentialConfig(
          {},
          { GEMINI_API_KEY: 'gemini-key' },
          ['google/gemini-3.8-flash'],
        ),
      ).toEqual({ google: { options: { apiKey: '{env:GEMINI_API_KEY}' } } });
    });

    it('prefers the SDK native name when both are set', () => {
      expect(
        mergeCatalogProviderCredentialConfig(
          {},
          {
            GEMINI_API_KEY: 'gemini-key',
            GOOGLE_GENERATIVE_AI_API_KEY: 'native-key',
          },
          ['google/gemini-3.8-flash'],
        ),
      ).toEqual({
        google: { options: { apiKey: '{env:GOOGLE_GENERATIVE_AI_API_KEY}' } },
      });
    });

    it('binds nothing when no key is visible, leaving the SDK default lookup alone', () => {
      // Binding to an unset name would hand OpenCode an empty key and break
      // a deployment the SDK's own lookup would have served.
      const providerConfig = {};

      expect(
        mergeCatalogProviderCredentialConfig(providerConfig, {}, [
          'google/gemini-3.8-flash',
        ]),
      ).toBe(providerConfig);
      expect(
        mergeCatalogProviderCredentialConfig(
          providerConfig,
          { GEMINI_API_KEY: '   ' },
          ['google/gemini-3.8-flash'],
        ),
      ).toBe(providerConfig);
    });
  });

  it('keeps Z.AI and the Z.AI Coding Plan on their own credentials', () => {
    const merged = mergeCatalogProviderCredentialConfig({}, {}, [
      'zai/glm-5.3',
      'zai-coding-plan/glm-5.3',
    ]);

    expect(merged).toMatchObject({
      zai: { options: { apiKey: '{env:ZAI_API_KEY}' } },
      'zai-coding-plan': {
        options: { apiKey: '{env:ZAI_CODING_PLAN_API_KEY}' },
      },
    });
  });

  it('points a provider at the configured region and leaves the default region to the catalog', () => {
    expect(
      mergeCatalogProviderCredentialConfig(
        {},
        { ZAI_CODING_PLAN_REGION: ' China ' },
        ['zai-coding-plan/glm-5.3'],
      ),
    ).toEqual({
      'zai-coding-plan': {
        options: {
          apiKey: '{env:ZAI_CODING_PLAN_API_KEY}',
          baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4',
        },
      },
    });

    for (const region of ['global', '', 'nowhere', undefined]) {
      const merged = mergeCatalogProviderCredentialConfig(
        {},
        { ZAI_CODING_PLAN_REGION: region },
        ['zai-coding-plan/glm-5.3'],
      ) as { 'zai-coding-plan': { options: Record<string, unknown> } };

      expect(merged['zai-coding-plan'].options).not.toHaveProperty('baseURL');
    }
  });

  it('reads each provider region from its own setting', () => {
    const merged = mergeCatalogProviderCredentialConfig(
      {},
      { ZAI_REGION: 'china' },
      ['zai/glm-5.3', 'zai-coding-plan/glm-5.3'],
    ) as Record<string, { options: Record<string, unknown> }>;

    expect(merged.zai!.options.baseURL).toBe(
      'https://open.bigmodel.cn/api/paas/v4',
    );
    expect(merged['zai-coding-plan']!.options).not.toHaveProperty('baseURL');
  });

  it('keeps existing provider options and model config over the defaults', () => {
    const merged = mergeCatalogProviderCredentialConfig(
      {
        'zai-coding-plan': {
          // e.g. the inference gateway rebase, or an operator override.
          options: {
            apiKey: '{env:ROOMOTE_CLOUD_TOKEN}',
            baseURL: 'https://gateway.example/zai-coding-plan',
          },
          models: { 'glm-5.3': { options: { thinking: { type: 'enabled' } } } },
        },
      },
      { ZAI_CODING_PLAN_REGION: 'china' },
      ['zai-coding-plan/glm-5.3'],
    );

    expect(merged).toEqual({
      'zai-coding-plan': {
        options: {
          apiKey: '{env:ROOMOTE_CLOUD_TOKEN}',
          baseURL: 'https://gateway.example/zai-coding-plan',
        },
        models: { 'glm-5.3': { options: { thinking: { type: 'enabled' } } } },
      },
    });
  });
});
