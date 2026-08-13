import {
  buildRecommendedDeploymentModelConfig,
  buildSetupModelStatus,
  collectSetupModelProviderCredentialValues,
  createEmptyDeploymentModelConfig,
  DEFAULT_MODEL_PROVIDER_CREDENTIAL_ENV_VAR_NAMES,
  DEFAULT_MODEL_PROVIDER_ENV_KEYS,
  DEFAULT_TASK_MODEL_ID,
  getDisplayModelProviderId,
  getModelProviderLabel,
  groupModelsByDisplayProvider,
  getModelProviderEnvKeyCandidates,
  getReasoningEffortLabel,
  getRecommendedModelPresets,
  getSetupModelProvider,
  normalizeDeploymentModelConfig,
  REASONING_EFFORT_OPTIONS,
  resolveSetupModelProviderIdFromModel,
  SETUP_MODEL_PROVIDER_CATALOG,
  type ReasoningEffort,
  type SetupModelProviderDescriptor,
} from './index';

describe('normalizeDeploymentModelConfig', () => {
  it('normalizes a fully populated config and trims whitespace', () => {
    expect(
      normalizeDeploymentModelConfig({
        roomoteModel: '  openai/gpt-5.4  ',
        roomoteSmallModel: '  anthropic/claude-sonnet-4  ',
        roomoteVisionModel: '  openai/gpt-5.5  ',
        roomoteCodeReviewModel: '  openai/gpt-5.5  ',
        roomoteExploreModel: '  openai/gpt-5.4-mini  ',
        roomotePlanningModel: null,
        roomoteModelReasoningEffort: null,
        roomoteSmallModelReasoningEffort: null,
        roomoteVisionModelReasoningEffort: null,
        roomoteCodeReviewModelReasoningEffort: null,
        roomoteExploreModelReasoningEffort: null,
        roomotePlanningModelReasoningEffort: null,
      }),
    ).toEqual({
      roomoteModel: 'openai/gpt-5.4',
      roomoteSmallModel: 'anthropic/claude-sonnet-4',
      roomoteVisionModel: 'openai/gpt-5.5',
      roomoteCodeReviewModel: 'openai/gpt-5.5',
      roomoteExploreModel: 'openai/gpt-5.4-mini',
      roomotePlanningModel: null,
      roomoteModelReasoningEffort: null,
      roomoteSmallModelReasoningEffort: null,
      roomoteVisionModelReasoningEffort: null,
      roomoteCodeReviewModelReasoningEffort: null,
      roomoteExploreModelReasoningEffort: null,
      roomotePlanningModelReasoningEffort: null,
    });
  });

  it('migrates persisted OpenCode DeepSeek Flash role models', () => {
    expect(
      normalizeDeploymentModelConfig({
        roomoteModel: 'opencode/deepseek-v4-flash-0731',
        roomoteSmallModel: 'opencode/deepseek-v4-flash-0731',
        roomoteVisionModel: 'opencode/deepseek-v4-flash-0731',
        roomoteCodeReviewModel: 'opencode/deepseek-v4-flash-0731',
        roomoteExploreModel: 'opencode/deepseek-v4-flash-0731',
        roomotePlanningModel: 'opencode/deepseek-v4-flash-0731',
      }),
    ).toMatchObject({
      roomoteModel: 'opencode/deepseek-v4-flash',
      roomoteSmallModel: 'opencode/deepseek-v4-flash',
      roomoteVisionModel: 'opencode/deepseek-v4-flash',
      roomoteCodeReviewModel: 'opencode/deepseek-v4-flash',
      roomoteExploreModel: 'opencode/deepseek-v4-flash',
      roomotePlanningModel: 'opencode/deepseek-v4-flash',
    });
  });

  it('coerces missing fields to null without dropping model keys', () => {
    expect(
      normalizeDeploymentModelConfig({ roomoteModel: 'openai/gpt-5.4' }),
    ).toEqual({
      roomoteModel: 'openai/gpt-5.4',
      roomoteSmallModel: null,
      roomoteVisionModel: null,
      roomoteCodeReviewModel: null,
      roomoteExploreModel: null,
      roomotePlanningModel: null,
      roomoteModelReasoningEffort: null,
      roomoteSmallModelReasoningEffort: null,
      roomoteVisionModelReasoningEffort: null,
      roomoteCodeReviewModelReasoningEffort: null,
      roomoteExploreModelReasoningEffort: null,
      roomotePlanningModelReasoningEffort: null,
    });
  });

  it('treats empty strings and whitespace as null', () => {
    expect(
      normalizeDeploymentModelConfig({
        roomoteModel: '   ',
        roomoteSmallModel: '',
        roomoteVisionModel: '  ',
        roomoteCodeReviewModel: '  ',
        roomoteExploreModel: '  ',
        roomotePlanningModel: null,
        roomoteModelReasoningEffort: null,
        roomoteSmallModelReasoningEffort: null,
        roomoteVisionModelReasoningEffort: null,
        roomoteCodeReviewModelReasoningEffort: null,
        roomoteExploreModelReasoningEffort: null,
        roomotePlanningModelReasoningEffort: null,
      }),
    ).toEqual({
      roomoteModel: null,
      roomoteSmallModel: null,
      roomoteVisionModel: null,
      roomoteCodeReviewModel: null,
      roomoteExploreModel: null,
      roomotePlanningModel: null,
      roomoteModelReasoningEffort: null,
      roomoteSmallModelReasoningEffort: null,
      roomoteVisionModelReasoningEffort: null,
      roomoteCodeReviewModelReasoningEffort: null,
      roomoteExploreModelReasoningEffort: null,
      roomotePlanningModelReasoningEffort: null,
    });
  });

  it('returns an empty config for null or undefined input', () => {
    expect(normalizeDeploymentModelConfig(null)).toEqual(
      createEmptyDeploymentModelConfig(),
    );
    expect(normalizeDeploymentModelConfig(undefined)).toEqual(
      createEmptyDeploymentModelConfig(),
    );
  });

  it('preserves null helper model (Same as coding model) while keeping the main model', () => {
    expect(
      normalizeDeploymentModelConfig({
        roomoteModel: DEFAULT_TASK_MODEL_ID,
        roomoteSmallModel: null,
        roomoteVisionModel: null,
        roomoteCodeReviewModel: null,
        roomoteExploreModel: null,
        roomotePlanningModel: null,
        roomoteModelReasoningEffort: null,
        roomoteSmallModelReasoningEffort: null,
        roomoteVisionModelReasoningEffort: null,
        roomoteCodeReviewModelReasoningEffort: null,
        roomoteExploreModelReasoningEffort: null,
        roomotePlanningModelReasoningEffort: null,
      }),
    ).toEqual({
      roomoteModel: DEFAULT_TASK_MODEL_ID,
      roomoteSmallModel: null,
      roomoteVisionModel: null,
      roomoteCodeReviewModel: null,
      roomoteExploreModel: null,
      roomotePlanningModel: null,
      roomoteModelReasoningEffort: null,
      roomoteSmallModelReasoningEffort: null,
      roomoteVisionModelReasoningEffort: null,
      roomoteCodeReviewModelReasoningEffort: null,
      roomoteExploreModelReasoningEffort: null,
      roomotePlanningModelReasoningEffort: null,
    });
  });

  it('normalizes a configured planning model and reasoning effort', () => {
    expect(
      normalizeDeploymentModelConfig({
        roomoteModel: 'openai/gpt-5.4',
        roomotePlanningModel: '  anthropic/claude-opus-4.7  ',
        roomoteExploreModel: null,
        roomoteExploreModelReasoningEffort: null,
        roomotePlanningModelReasoningEffort: 'xhigh',
      }),
    ).toEqual({
      roomoteModel: 'openai/gpt-5.4',
      roomoteSmallModel: null,
      roomoteVisionModel: null,
      roomoteCodeReviewModel: null,
      roomoteExploreModel: null,
      roomotePlanningModel: 'anthropic/claude-opus-4.7',
      roomoteModelReasoningEffort: null,
      roomoteSmallModelReasoningEffort: null,
      roomoteVisionModelReasoningEffort: null,
      roomoteCodeReviewModelReasoningEffort: null,
      roomoteExploreModelReasoningEffort: null,
      roomotePlanningModelReasoningEffort: 'xhigh',
    });
  });

  it('keeps valid reasoning efforts and coerces invalid ones to null', () => {
    expect(
      normalizeDeploymentModelConfig({
        roomoteModel: 'openai/gpt-5.4',
        roomoteModelReasoningEffort: 'high',
        roomoteSmallModelReasoningEffort: 'turbo' as unknown as ReasoningEffort,
        roomoteCodeReviewModelReasoningEffort: 'xhigh',
        roomoteExploreModelReasoningEffort: 'high',
        roomotePlanningModelReasoningEffort: null,
      }),
    ).toEqual({
      roomoteModel: 'openai/gpt-5.4',
      roomoteSmallModel: null,
      roomoteVisionModel: null,
      roomoteCodeReviewModel: null,
      roomoteExploreModel: null,
      roomotePlanningModel: null,
      roomoteModelReasoningEffort: 'high',
      roomoteSmallModelReasoningEffort: null,
      roomoteVisionModelReasoningEffort: null,
      roomoteCodeReviewModelReasoningEffort: 'xhigh',
      roomoteExploreModelReasoningEffort: 'high',
      roomotePlanningModelReasoningEffort: null,
    });
  });

  it('clears model roles that still reference disabled providers', () => {
    expect(
      normalizeDeploymentModelConfig({
        roomoteModel: 'google-vertex/claude-sonnet-5@default',
        roomoteSmallModel: 'google-vertex/gemini-3.5-flash',
        roomoteVisionModel: 'google/gemini-3.5-flash',
        roomoteCodeReviewModel: 'mistral/mistral-large-latest',
      }),
    ).toMatchObject({
      roomoteModel: null,
      roomoteSmallModel: null,
      roomoteVisionModel: 'google/gemini-3.5-flash',
      roomoteCodeReviewModel: null,
    });
  });
});

describe('SETUP_MODEL_PROVIDER_CATALOG', () => {
  it('exposes the supported setup providers for the onboarding UI', () => {
    expect(SETUP_MODEL_PROVIDER_CATALOG.map((provider) => provider.id)).toEqual(
      [
        'openrouter',
        'vercel',
        'requesty',
        'baseten',
        'togetherai',
        'openai',
        'azure',
        'azure-cognitive-services',
        'anthropic',
        'moonshotai',
        'kimi-for-coding',
        'minimax',
        'opencode',
        'opencode-go',
        'amazon-bedrock',
        'google',
        'xai',
        'zai',
        'zai-coding-plan',
        'github-copilot',
        'openai-compatible',
        'litellm',
        'ollama',
        'vllm',
        'chatgpt',
        'xai-subscription',
      ],
    );
  });

  it('keeps recommended-model slugs and default models under each provider prefix', () => {
    for (const provider of SETUP_MODEL_PROVIDER_CATALOG) {
      if ('dynamicModels' in provider && provider.dynamicModels) {
        expect(provider.defaultRoomoteModel).toBe('');
        expect(provider.suggestedTaskModels).toEqual([]);
        continue;
      }
      // ChatGPT serves openai/ models; SuperGrok serves xai/; Bedrock uses
      // the worker's custom bedrock-mantle/ OpenCode provider.
      const expectedPrefix =
        provider.id === 'chatgpt'
          ? 'openai/'
          : provider.id === 'xai-subscription'
            ? 'xai/'
            : provider.id === 'amazon-bedrock'
              ? 'bedrock-mantle/'
              : `${provider.id}/`;

      expect(provider.defaultRoomoteModel.startsWith(expectedPrefix)).toBe(
        true,
      );

      for (const suggestion of provider.suggestedTaskModels) {
        expect(suggestion.id.startsWith(expectedPrefix)).toBe(true);
        expect(suggestion.displayName.length).toBeGreaterThan(0);
        expect(suggestion.family?.length).toBeGreaterThan(0);
      }
    }
  });

  it('keeps preset models under the provider prefix and supplies metadata outside the suggested catalog', () => {
    const providers: readonly SetupModelProviderDescriptor[] =
      SETUP_MODEL_PROVIDER_CATALOG;

    for (const provider of providers) {
      if (provider.dynamicModels) {
        continue;
      }

      const expectedPrefix =
        provider.id === 'chatgpt'
          ? 'openai/'
          : provider.id === 'xai-subscription'
            ? 'xai/'
            : provider.id === 'amazon-bedrock'
              ? 'bedrock-mantle/'
              : `${provider.id}/`;
      const suggestedModelIds = new Set(
        provider.suggestedTaskModels.map((suggestion) => suggestion.id),
      );

      for (const preset of getRecommendedModelPresets(provider)) {
        for (const role of Object.values(preset.roles)) {
          expect(role.modelId.startsWith(expectedPrefix)).toBe(true);
          if (!suggestedModelIds.has(role.modelId)) {
            expect(
              role.displayName?.length ||
                role.modelId.split('/').at(-1)?.length,
            ).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('recommends Kimi K3 only from supported providers', () => {
    const kimiK3ByProvider = SETUP_MODEL_PROVIDER_CATALOG.flatMap(
      (provider) => {
        const model = provider.suggestedTaskModels.find(
          (suggestion) => suggestion.displayName === 'Kimi K3',
        );

        return model ? [{ providerId: provider.id, modelId: model.id }] : [];
      },
    );

    expect(kimiK3ByProvider).toEqual([
      { providerId: 'openrouter', modelId: 'openrouter/moonshotai/kimi-k3' },
      { providerId: 'vercel', modelId: 'vercel/moonshotai/kimi-k3' },
      { providerId: 'requesty', modelId: 'requesty/kimi-k3' },
      { providerId: 'baseten', modelId: 'baseten/moonshotai/Kimi-K3' },
      { providerId: 'togetherai', modelId: 'togetherai/moonshotai/Kimi-K3' },
      { providerId: 'moonshotai', modelId: 'moonshotai/kimi-k3' },
      { providerId: 'kimi-for-coding', modelId: 'kimi-for-coding/k3' },
      { providerId: 'opencode', modelId: 'opencode/kimi-k3' },
      { providerId: 'opencode-go', modelId: 'opencode-go/kimi-k3' },
    ]);
  });

  it('recommends Qwen3.8 Max only from supported providers', () => {
    const providersByModel = SETUP_MODEL_PROVIDER_CATALOG.flatMap(
      (provider) => {
        const model = provider.suggestedTaskModels.find(
          (suggestion) => suggestion.displayName === 'Qwen3.8 Max',
        );

        return model ? [{ providerId: provider.id, modelId: model.id }] : [];
      },
    );

    expect(providersByModel).toEqual([
      { providerId: 'openrouter', modelId: 'openrouter/qwen/qwen3.8-max' },
      { providerId: 'vercel', modelId: 'vercel/alibaba/qwen3.8-max' },
      { providerId: 'opencode-go', modelId: 'opencode-go/qwen3.8-max' },
    ]);
  });

  it('uses the requested OpenCode Go role defaults', () => {
    expect(
      buildRecommendedDeploymentModelConfig(
        getSetupModelProvider('opencode-go'),
      ),
    ).toMatchObject({
      roomoteModel: 'opencode-go/glm-5.2',
      roomoteSmallModel: 'opencode-go/gpt-5.6-luna',
      roomoteVisionModel: 'opencode-go/gpt-5.6-luna',
      roomoteCodeReviewModel: 'opencode-go/minimax-m3',
      roomoteExploreModel: 'opencode-go/deepseek-v4-flash',
      roomotePlanningModel: 'opencode-go/qwen3.8-max',
    });
  });

  it.each([
    {
      displayName: 'GPT 5.6 Sol',
      modelId: 'gpt-5.6-sol',
    },
    {
      displayName: 'GPT 5.6 Terra',
      modelId: 'gpt-5.6-terra',
    },
    {
      displayName: 'GPT 5.6 Luna',
      modelId: 'gpt-5.6-luna',
    },
  ])(
    'recommends $displayName only from providers that support it',
    ({ displayName, modelId }) => {
      const providersByModel = SETUP_MODEL_PROVIDER_CATALOG.flatMap(
        (provider) => {
          const model = provider.suggestedTaskModels.find(
            (suggestion) => suggestion.displayName === displayName,
          );

          return model ? [{ providerId: provider.id, modelId: model.id }] : [];
        },
      );

      expect(providersByModel).toEqual([
        { providerId: 'openrouter', modelId: `openrouter/openai/${modelId}` },
        { providerId: 'vercel', modelId: `vercel/openai/${modelId}` },
        { providerId: 'requesty', modelId: `requesty/${modelId}@eu` },
        { providerId: 'openai', modelId: `openai/${modelId}` },
        { providerId: 'azure', modelId: `azure/${modelId}` },
        {
          providerId: 'azure-cognitive-services',
          modelId: `azure-cognitive-services/${modelId}`,
        },
        { providerId: 'opencode', modelId: `opencode/${modelId}` },
        ...(modelId === 'gpt-5.6-luna'
          ? [
              {
                providerId: 'opencode-go',
                modelId: 'opencode-go/gpt-5.6-luna',
              },
            ]
          : []),
        {
          providerId: 'amazon-bedrock',
          modelId: `bedrock-mantle/openai.${modelId}`,
        },
        { providerId: 'github-copilot', modelId: `github-copilot/${modelId}` },
        { providerId: 'chatgpt', modelId: `openai/${modelId}` },
      ]);
    },
  );

  it('recommends Gemini 3.6 Flash only from providers that support it', () => {
    const geminiFlashByProvider = SETUP_MODEL_PROVIDER_CATALOG.flatMap(
      (provider) => {
        const model = provider.suggestedTaskModels.find(
          (suggestion) => suggestion.displayName === 'Gemini 3.6 Flash',
        );

        return model ? [{ providerId: provider.id, modelId: model.id }] : [];
      },
    );

    expect(geminiFlashByProvider).toEqual([
      {
        providerId: 'openrouter',
        modelId: 'openrouter/google/gemini-3.6-flash',
      },
      { providerId: 'vercel', modelId: 'vercel/google/gemini-3.6-flash' },
      { providerId: 'requesty', modelId: 'requesty/gemini-3.6-flash' },
      { providerId: 'opencode', modelId: 'opencode/gemini-3.6-flash' },
      { providerId: 'google', modelId: 'google/gemini-3.6-flash' },
    ]);
  });

  it("uses each provider's DeepSeek V4 Flash 0731 model slug", () => {
    const deepSeekFlashByProvider = SETUP_MODEL_PROVIDER_CATALOG.flatMap(
      (provider) => {
        const model = provider.suggestedTaskModels.find(
          (suggestion) => suggestion.displayName === 'DeepSeek V4 Flash 0731',
        );

        return model ? [{ providerId: provider.id, modelId: model.id }] : [];
      },
    );

    expect(deepSeekFlashByProvider).toEqual([
      {
        providerId: 'openrouter',
        modelId: 'openrouter/deepseek/deepseek-v4-flash-0731',
      },
      {
        providerId: 'vercel',
        modelId: 'vercel/deepseek/deepseek-v4-flash-0731',
      },
      {
        providerId: 'requesty',
        modelId: 'requesty/deepseek-v4-flash-0731',
      },
      {
        providerId: 'baseten',
        modelId: 'baseten/deepseek-ai/DeepSeek-V4-Flash-0731',
      },
      {
        providerId: 'opencode',
        modelId: 'opencode/deepseek-v4-flash',
      },
      {
        providerId: 'opencode-go',
        modelId: 'opencode-go/deepseek-v4-flash',
      },
    ]);
  });

  it('registers Kimi for Coding as an Anthropic-style API-key provider', () => {
    expect(getSetupModelProvider('kimi-for-coding')).toMatchObject({
      id: 'kimi-for-coding',
      label: 'Kimi for Coding',
      envVarName: 'KIMI_API_KEY',
      envVarLabel: 'Kimi for Coding API key',
      authKind: 'api-key',
      defaultRoomoteModel: 'kimi-for-coding/k3',
    });
  });

  it('maps Amazon Bedrock to a Bedrock API key plus an optional AWS region', () => {
    const bedrockProvider = SETUP_MODEL_PROVIDER_CATALOG.find(
      (provider) => provider.id === 'amazon-bedrock',
    );

    expect(bedrockProvider).toMatchObject({
      label: 'Amazon Bedrock',
      envVarName: 'AWS_BEARER_TOKEN_BEDROCK',
      envVarLabel: 'API key',
      credentialHelp: {
        text: 'Paste a key generated from the Bedrock API-key console. The same regional key serves native Bedrock and Mantle models.',
        href: 'https://us-east-1.console.aws.amazon.com/bedrock-mantle/api-keys',
        linkLabel: 'Open AWS Bedrock API keys',
      },
      defaultRoomoteModel: 'bedrock-mantle/anthropic.claude-sonnet-5',
    });
    expect(bedrockProvider?.additionalEnvFields).toEqual([
      {
        envVarName: 'AWS_REGION',
        label: 'AWS region',
        secret: false,
        required: false,
        placeholder: 'us-east-1',
      },
    ]);
  });

  it('maps Google Gemini to the GEMINI_API_KEY env var', () => {
    const googleProvider = SETUP_MODEL_PROVIDER_CATALOG.find(
      (provider) => provider.id === 'google',
    );

    expect(googleProvider).toMatchObject({
      label: 'Google Gemini',
      envVarName: 'GEMINI_API_KEY',
      defaultRoomoteModel: 'google/gemini-3.6-flash',
    });
  });

  it.each([
    [
      'azure',
      'Azure OpenAI',
      'AZURE_API_KEY',
      'AZURE_RESOURCE_NAME',
      'azure/gpt-5.6-terra',
    ],
    [
      'azure-cognitive-services',
      'Azure AI Foundry',
      'AZURE_COGNITIVE_SERVICES_API_KEY',
      'AZURE_COGNITIVE_SERVICES_RESOURCE_NAME',
      'azure-cognitive-services/gpt-5.6-terra',
    ],
  ] as const)(
    'maps %s to its API key and required non-secret resource name',
    (providerId, label, apiKeyEnvVarName, resourceEnvVarName, defaultModel) => {
      const provider = getSetupModelProvider(providerId);

      expect(provider).toMatchObject({
        id: providerId,
        label,
        envVarName: apiKeyEnvVarName,
        authKind: 'api-key',
        defaultRoomoteModel: defaultModel,
        credentialHelp: {
          href: 'https://portal.azure.com/',
          linkLabel: 'Open Azure portal',
        },
      });
      expect(provider.additionalEnvFields).toEqual([
        {
          envVarName: resourceEnvVarName,
          label: 'Resource name',
          secret: false,
          required: true,
          placeholder: 'my-resource',
        },
      ]);
      expect(getModelProviderLabel(providerId)).toBe(label);
      expect(resolveSetupModelProviderIdFromModel(defaultModel)).toBe(
        providerId,
      );
    },
  );

  it('maps Vercel AI Gateway to the AI_GATEWAY_API_KEY env var', () => {
    const vercelProvider = SETUP_MODEL_PROVIDER_CATALOG.find(
      (provider) => provider.id === 'vercel',
    );

    expect(vercelProvider).toMatchObject({
      label: 'Vercel AI Gateway',
      envVarName: 'AI_GATEWAY_API_KEY',
      defaultRoomoteModel: 'vercel/openai/gpt-5.6-terra',
    });
  });

  it('registers the ChatGPT subscription provider as an OAuth provider with no env var', () => {
    const chatgptProvider = SETUP_MODEL_PROVIDER_CATALOG.find(
      (provider) => provider.id === 'chatgpt',
    );

    expect(chatgptProvider).toMatchObject({
      id: 'chatgpt',
      label: 'ChatGPT (subscription)',
      authKind: 'oauth',
      defaultRoomoteModel: 'openai/gpt-5.6-sol',
    });
    expect(chatgptProvider?.envVarName).toBeUndefined();
  });

  it('groups openai/ models under ChatGPT when only a subscription is connected', () => {
    expect(
      getDisplayModelProviderId('openai/gpt-5.6-terra', {
        chatgptConnected: true,
      }),
    ).toBe('chatgpt');
    expect(
      getDisplayModelProviderId('openai/gpt-5.6-terra', {
        chatgptConnected: false,
      }),
    ).toBe('openai');
    expect(
      getDisplayModelProviderId('anthropic/claude-sonnet-5', {
        chatgptConnected: true,
      }),
    ).toBe('anthropic');
    // Subscription-only callers (omit openaiConnected) still group under ChatGPT.
    expect(
      getDisplayModelProviderId('openai/gpt-5.6-terra', {
        chatgptConnected: true,
      }),
    ).toBe('chatgpt');
  });

  it('keeps openai/ models under OpenAI when an API key is also connected', () => {
    expect(
      getDisplayModelProviderId('openai/gpt-5.6-terra', {
        chatgptConnected: true,
        openaiConnected: true,
      }),
    ).toBe('openai');
  });

  it('groups xai/ models under the Grok subscription when it is the only xAI connection', () => {
    expect(
      getDisplayModelProviderId('xai/grok-4.5', {
        xaiSubscriptionConnected: true,
      }),
    ).toBe('xai-subscription');
    expect(getDisplayModelProviderId('xai/grok-4.5', {})).toBe('xai');
    expect(
      getDisplayModelProviderId('openai/gpt-5.6-terra', {
        xaiSubscriptionConnected: true,
      }),
    ).toBe('openai');
  });

  it('keeps xai/ models under xAI when an API key is also connected', () => {
    expect(
      getDisplayModelProviderId('xai/grok-4.5', {
        xaiSubscriptionConnected: true,
        xaiConnected: true,
      }),
    ).toBe('xai');
  });

  it('groups native Bedrock and Mantle models under Amazon Bedrock', () => {
    expect(
      groupModelsByDisplayProvider([
        {
          id: 'amazon-bedrock/anthropic.claude-opus-4-8',
          displayName: 'Claude Opus 4.8',
        },
        {
          id: 'bedrock-mantle/anthropic.claude-sonnet-5',
          displayName: 'Claude Sonnet 5',
        },
      ]),
    ).toEqual([
      {
        providerId: 'amazon-bedrock',
        label: 'Amazon Bedrock',
        items: [
          {
            id: 'amazon-bedrock/anthropic.claude-opus-4-8',
            displayName: 'Claude Opus 4.8',
          },
          {
            id: 'bedrock-mantle/anthropic.claude-sonnet-5',
            displayName: 'Claude Sonnet 5',
          },
        ],
      },
    ]);
  });

  it('groups model chooser options by display provider and catalog order', () => {
    const groups = groupModelsByDisplayProvider(
      [
        { id: 'openai/gpt-5.6-terra', displayName: 'GPT 5.6 Terra' },
        {
          id: 'openrouter/x-ai/grok-4.6',
          displayName: 'Grok 4.6',
        },
        {
          id: 'openrouter/anthropic/claude-sonnet-5',
          displayName: 'Claude Sonnet 5',
        },
      ],
      { chatgptConnected: true },
    );

    expect(groups.map((group) => group.providerId)).toEqual([
      'openrouter',
      'chatgpt',
    ]);
    expect(groups[0]).toMatchObject({
      label: 'OpenRouter',
      items: [
        { id: 'openrouter/x-ai/grok-4.6' },
        { id: 'openrouter/anthropic/claude-sonnet-5' },
      ],
    });
    expect(groups[1]).toMatchObject({
      label: 'ChatGPT (subscription)',
      items: [{ id: 'openai/gpt-5.6-terra' }],
    });
  });

  it('maps Requesty to its current models.dev catalog and recommended roles', () => {
    const requestyProvider = SETUP_MODEL_PROVIDER_CATALOG.find(
      (provider) => provider.id === 'requesty',
    );

    expect(requestyProvider).toMatchObject({
      label: 'Requesty',
      envVarName: 'REQUESTY_API_KEY',
      defaultRoomoteModel: 'requesty/claude-sonnet-5',
      recommendedRoleModels: {
        helper: 'requesty/gemini-3.6-flash',
        codeReview: 'requesty/claude-sonnet-5',
        explore: 'requesty/gemini-3.6-flash',
        planning: 'requesty/claude-opus-5',
      },
    });
    expect(
      requestyProvider?.suggestedTaskModels.map((model) => model.id),
    ).toEqual([
      'requesty/claude-fable-5',
      'requesty/claude-haiku-4-5',
      'requesty/claude-opus-5',
      'requesty/claude-sonnet-5',
      'requesty/gpt-5.6-sol@eu',
      'requesty/gpt-5.6-terra@eu',
      'requesty/gpt-5.6-luna@eu',
      'requesty/gemini-3.6-flash',
      'requesty/deepseek-v4-flash-0731',
      'requesty/glm-5.2',
      'requesty/kimi-k3',
      'requesty/grok-4.6',
    ]);
  });

  it('offers Requesty for new connections', () => {
    const unconnected = buildSetupModelStatus({});

    expect(
      unconnected.providers.some((provider) => provider.id === 'requesty'),
    ).toBe(true);
  });

  it('maps Baseten to the BASETEN_API_KEY env var', () => {
    const basetenProvider = SETUP_MODEL_PROVIDER_CATALOG.find(
      (provider) => provider.id === 'baseten',
    );

    expect(basetenProvider).toMatchObject({
      label: 'Baseten',
      envVarName: 'BASETEN_API_KEY',
      defaultRoomoteModel: 'baseten/moonshotai/Kimi-K2.7-Code',
      authKind: 'api-key',
    });
  });

  it('maps Together AI to the TOGETHER_API_KEY env var', () => {
    const togetherProvider = SETUP_MODEL_PROVIDER_CATALOG.find(
      (provider) => provider.id === 'togetherai',
    );

    expect(togetherProvider).toMatchObject({
      label: 'Together AI',
      envVarName: 'TOGETHER_API_KEY',
      defaultRoomoteModel: 'togetherai/deepseek-ai/DeepSeek-V4-Pro',
      authKind: 'api-key',
    });
  });

  it('registers GitHub Copilot as an OAuth provider with github-copilot/ models', () => {
    const copilotProvider = SETUP_MODEL_PROVIDER_CATALOG.find(
      (provider) => provider.id === 'github-copilot',
    );

    expect(copilotProvider).toMatchObject({
      label: 'GitHub Copilot',
      defaultRoomoteModel: 'github-copilot/claude-sonnet-5',
      authKind: 'oauth',
    });
    expect(copilotProvider?.envVarName).toBeUndefined();
    expect(
      copilotProvider?.suggestedTaskModels.some(
        (suggestion) => suggestion.id === 'github-copilot/claude-sonnet-5',
      ),
    ).toBe(true);
  });

  it('marks GitHub Copilot connected only from its OAuth record', () => {
    const oauthStatus = buildSetupModelStatus({
      githubCopilotConnected: true,
    }).providers.find((provider) => provider.id === 'github-copilot');
    expect(oauthStatus?.savedApiKeySatisfied).toBe(true);

    const disconnected = buildSetupModelStatus({}).providers.find(
      (provider) => provider.id === 'github-copilot',
    );
    expect(disconnected?.runtimeApiKeySatisfied).toBe(false);
    expect(disconnected?.savedApiKeySatisfied).toBe(false);
  });

  it('lets xAI API and Grok subscription switch between Grok 4.6 and Grok 4.5', () => {
    for (const providerId of ['xai', 'xai-subscription'] as const) {
      const provider = SETUP_MODEL_PROVIDER_CATALOG.find(
        (entry) => entry.id === providerId,
      );

      expect(provider?.defaultRoomoteModel).toBe('xai/grok-4.6');
      expect(provider?.suggestedTaskModels.map((model) => model.id)).toEqual([
        'xai/grok-4.6',
        'xai/grok-4.5',
      ]);
      expect(
        provider?.suggestedTaskModels.map((model) => model.displayName),
      ).toEqual(['Grok 4.6', 'Grok 4.5']);
    }
  });

  it('marks xAI Grok subscription connected as its own OAuth provider without an API key', () => {
    const status = buildSetupModelStatus({
      xaiSubscriptionConnected: true,
    });
    const subscription = status.providers.find(
      (provider) => provider.id === 'xai-subscription',
    );
    const xaiKey = status.providers.find((provider) => provider.id === 'xai');
    expect(subscription?.savedApiKeySatisfied).toBe(true);
    expect(xaiKey?.savedApiKeySatisfied).toBe(false);
    expect(status.xaiSubscriptionConnected).toBe(true);
    expect(status.xaiApiKeyConnected).toBe(false);
  });

  it('reports xaiApiKeyConnected when XAI_API_KEY is present', () => {
    const status = buildSetupModelStatus({
      persistedEnvVarNames: ['XAI_API_KEY'],
    });
    expect(status.xaiApiKeyConnected).toBe(true);
    expect(status.xaiSubscriptionConnected).toBe(false);
  });
});

describe('buildRecommendedDeploymentModelConfig', () => {
  it.each(['openai', 'chatgpt'] as const)(
    'builds the %s presets with role-specific reasoning',
    (providerId) => {
      const provider = getSetupModelProvider(providerId);

      expect(buildRecommendedDeploymentModelConfig(provider)).toEqual({
        roomoteModel: 'openai/gpt-5.6-sol',
        roomoteSmallModel: 'openai/gpt-5.6-luna',
        roomoteVisionModel: 'openai/gpt-5.6-sol',
        roomoteCodeReviewModel: 'openai/gpt-5.6-terra',
        roomoteExploreModel: 'openai/gpt-5.6-luna',
        roomotePlanningModel: 'openai/gpt-5.6-sol',
        roomoteModelReasoningEffort: 'medium',
        roomoteSmallModelReasoningEffort: 'low',
        roomoteVisionModelReasoningEffort: 'low',
        roomoteCodeReviewModelReasoningEffort: 'high',
        roomoteExploreModelReasoningEffort: 'low',
        roomotePlanningModelReasoningEffort: 'xhigh',
      });
      expect(
        buildRecommendedDeploymentModelConfig(provider, 'luna-max'),
      ).toEqual({
        roomoteModel: 'openai/gpt-5.6-luna',
        roomoteSmallModel: 'openai/gpt-5.6-luna',
        roomoteVisionModel: 'openai/gpt-5.6-sol',
        roomoteCodeReviewModel: 'openai/gpt-5.6-terra',
        roomoteExploreModel: 'openai/gpt-5.6-luna',
        roomotePlanningModel: 'openai/gpt-5.6-sol',
        roomoteModelReasoningEffort: 'max',
        roomoteSmallModelReasoningEffort: 'low',
        roomoteVisionModelReasoningEffort: 'low',
        roomoteCodeReviewModelReasoningEffort: 'high',
        roomoteExploreModelReasoningEffort: 'low',
        roomotePlanningModelReasoningEffort: 'xhigh',
      });
    },
  );

  it('maps the provider default to coding and recommended models to their roles', () => {
    expect(
      buildRecommendedDeploymentModelConfig(getSetupModelProvider('anthropic')),
    ).toEqual({
      roomoteModel: 'anthropic/claude-sonnet-5',
      roomoteSmallModel: 'anthropic/claude-haiku-4-5',
      roomoteVisionModel: null,
      roomoteCodeReviewModel: 'anthropic/claude-sonnet-5',
      roomoteExploreModel: 'anthropic/claude-haiku-4-5',
      roomotePlanningModel: 'anthropic/claude-opus-5',
      roomoteModelReasoningEffort: null,
      roomoteSmallModelReasoningEffort: null,
      roomoteVisionModelReasoningEffort: null,
      roomoteCodeReviewModelReasoningEffort: 'medium',
      roomoteExploreModelReasoningEffort: null,
      roomotePlanningModelReasoningEffort: null,
    });
  });

  it.each([
    [
      'openrouter',
      'balanced',
      'openrouter/anthropic/claude-sonnet-5',
      'openrouter/anthropic/claude-opus-5',
    ],
    [
      'openrouter',
      'quick-turnaround',
      'openrouter/anthropic/claude-sonnet-5',
      'openrouter/anthropic/claude-opus-5',
    ],
    [
      'vercel',
      undefined,
      'vercel/anthropic/claude-sonnet-5',
      'vercel/anthropic/claude-opus-5',
    ],
    [
      'anthropic',
      undefined,
      'anthropic/claude-sonnet-5',
      'anthropic/claude-opus-5',
    ],
    [
      'opencode',
      undefined,
      'opencode/claude-sonnet-5',
      'opencode/claude-opus-5',
    ],
    [
      'amazon-bedrock',
      undefined,
      'bedrock-mantle/anthropic.claude-sonnet-5',
      'bedrock-mantle/anthropic.claude-opus-5',
    ],
    [
      'github-copilot',
      undefined,
      'github-copilot/claude-sonnet-5',
      'github-copilot/claude-opus-5',
    ],
  ] as const)(
    'recommends Sonnet 5 with medium reasoning for %s code review',
    (providerId, presetId, codeReviewModel, planningModel) => {
      expect(
        buildRecommendedDeploymentModelConfig(
          getSetupModelProvider(providerId),
          presetId,
        ),
      ).toMatchObject({
        roomoteCodeReviewModel: codeReviewModel,
        roomoteCodeReviewModelReasoningEffort: 'medium',
        roomotePlanningModel: planningModel,
      });
    },
  );

  it('recommends only the coding default for providers without a role mapping', () => {
    expect(
      buildRecommendedDeploymentModelConfig(getSetupModelProvider('xai')),
    ).toEqual({
      ...createEmptyDeploymentModelConfig(),
      roomoteModel: 'xai/grok-4.6',
    });
  });

  it('recommends Gemini Flash for every Google Gemini role', () => {
    expect(
      buildRecommendedDeploymentModelConfig(getSetupModelProvider('google')),
    ).toEqual({
      ...createEmptyDeploymentModelConfig(),
      roomoteModel: 'google/gemini-3.6-flash',
    });
  });

  it('recommends Kimi K3 for Moonshot vision, code review, and planning', () => {
    expect(
      buildRecommendedDeploymentModelConfig(
        getSetupModelProvider('moonshotai'),
      ),
    ).toEqual({
      roomoteModel: 'moonshotai/kimi-k2.7-code',
      roomoteSmallModel: null,
      roomoteVisionModel: 'moonshotai/kimi-k3',
      roomoteCodeReviewModel: 'moonshotai/kimi-k3',
      roomoteExploreModel: null,
      roomotePlanningModel: 'moonshotai/kimi-k3',
      roomoteModelReasoningEffort: null,
      roomoteSmallModelReasoningEffort: null,
      roomoteVisionModelReasoningEffort: null,
      roomoteCodeReviewModelReasoningEffort: null,
      roomoteExploreModelReasoningEffort: null,
      roomotePlanningModelReasoningEffort: null,
    });
  });

  it('recommends Kimi for Coding defaults and role models', () => {
    expect(
      buildRecommendedDeploymentModelConfig(
        getSetupModelProvider('kimi-for-coding'),
      ),
    ).toEqual({
      roomoteModel: 'kimi-for-coding/k3',
      roomoteSmallModel: 'kimi-for-coding/k2p7',
      roomoteVisionModel: 'kimi-for-coding/k3',
      roomoteCodeReviewModel: 'kimi-for-coding/k3',
      roomoteExploreModel: 'kimi-for-coding/k2p7',
      roomotePlanningModel: 'kimi-for-coding/k3',
      roomoteModelReasoningEffort: null,
      roomoteSmallModelReasoningEffort: null,
      roomoteVisionModelReasoningEffort: null,
      roomoteCodeReviewModelReasoningEffort: null,
      roomoteExploreModelReasoningEffort: null,
      roomotePlanningModelReasoningEffort: null,
    });
  });

  it('synthesizes a default preset from the legacy role mapping', () => {
    const presets = getRecommendedModelPresets({
      defaultRoomoteModel: 'example/coding',
      recommendedRoleModels: { helper: 'example/helper' },
      recommendedRoleReasoningEfforts: { helper: 'low' },
    });

    expect(presets).toEqual([
      {
        id: 'default',
        label: 'Recommended',
        default: true,
        roles: {
          coding: { modelId: 'example/coding' },
          helper: { modelId: 'example/helper', reasoningEffort: 'low' },
        },
      },
    ]);
  });

  it('resolves arbitrary preset ids and labels with role reasoning efforts', () => {
    const provider = {
      defaultRoomoteModel: 'example/default',
      recommendedPresets: [
        {
          id: 'ship-it',
          label: 'Ship it',
          default: true,
          roles: {
            coding: {
              modelId: 'example/coding',
              reasoningEffort: 'high' as const,
            },
            helper: {
              modelId: 'example/helper',
              reasoningEffort: 'low' as const,
            },
          },
        },
        {
          id: 'careful-review',
          label: 'Careful review',
          roles: {
            coding: {
              modelId: 'example/review',
              reasoningEffort: 'xhigh' as const,
            },
            codeReview: {
              modelId: 'example/reviewer',
              reasoningEffort: 'xhigh' as const,
            },
          },
        },
      ],
    };

    expect(buildRecommendedDeploymentModelConfig(provider)).toMatchObject({
      roomoteModel: 'example/coding',
      roomoteSmallModel: 'example/helper',
      roomoteModelReasoningEffort: 'high',
      roomoteSmallModelReasoningEffort: 'low',
    });
    expect(
      buildRecommendedDeploymentModelConfig(provider, 'careful-review'),
    ).toMatchObject({
      roomoteModel: 'example/review',
      roomoteCodeReviewModel: 'example/reviewer',
      roomoteModelReasoningEffort: 'xhigh',
      roomoteCodeReviewModelReasoningEffort: 'xhigh',
    });
  });
});

describe('getModelProviderEnvKeyCandidates', () => {
  it('derives known provider keys from the shared setup catalog metadata', () => {
    expect(
      getModelProviderEnvKeyCandidates({
        providerId: 'vercel',
      }),
    ).toEqual(['AI_GATEWAY_API_KEY']);
  });

  it('derives the Requesty provider key from the shared setup catalog metadata', () => {
    expect(
      getModelProviderEnvKeyCandidates({
        providerId: 'requesty',
      }),
    ).toEqual(['REQUESTY_API_KEY']);
  });

  it('derives the Baseten provider key from the shared setup catalog metadata', () => {
    expect(
      getModelProviderEnvKeyCandidates({
        providerId: 'baseten',
      }),
    ).toEqual(['BASETEN_API_KEY']);
  });

  it('derives the Together AI provider key from the shared setup catalog metadata', () => {
    expect(
      getModelProviderEnvKeyCandidates({
        providerId: 'togetherai',
      }),
    ).toEqual(['TOGETHER_API_KEY']);
  });

  it('includes configured custom provider env keys after the known defaults', () => {
    expect(
      getModelProviderEnvKeyCandidates({
        providerId: 'openrouter',
        configuredEnvKeys: 'CUSTOM_PROVIDER_API_KEY OPENROUTER_API_KEY',
      }),
    ).toEqual(['OPENROUTER_API_KEY', 'CUSTOM_PROVIDER_API_KEY']);
  });

  it('includes every declared env var for enabled multi-credential providers', () => {
    expect(
      getModelProviderEnvKeyCandidates({ providerId: 'amazon-bedrock' }),
    ).toEqual(['AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION']);
    expect(
      getModelProviderEnvKeyCandidates({ providerId: 'bedrock-mantle' }),
    ).toEqual(['AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION']);
    expect(
      getModelProviderEnvKeyCandidates({ providerId: 'google-vertex' }),
    ).toEqual([]);
    expect(getModelProviderEnvKeyCandidates({ providerId: 'mistral' })).toEqual(
      [],
    );
    expect(
      getModelProviderEnvKeyCandidates({ providerId: 'github-copilot' }),
    ).toEqual([]);
  });

  it('merges catalog and extra env keys for the google provider', () => {
    expect(getModelProviderEnvKeyCandidates({ providerId: 'google' })).toEqual([
      'GEMINI_API_KEY',
      'GOOGLE_GENERATIVE_AI_API_KEY',
    ]);
  });

  it('publishes the flattened default provider env key list', () => {
    expect(DEFAULT_MODEL_PROVIDER_ENV_KEYS).toContain('AI_GATEWAY_API_KEY');
    expect(DEFAULT_MODEL_PROVIDER_ENV_KEYS).toContain('AZURE_API_KEY');
    expect(DEFAULT_MODEL_PROVIDER_ENV_KEYS).toContain('AZURE_RESOURCE_NAME');
    expect(DEFAULT_MODEL_PROVIDER_ENV_KEYS).toContain(
      'AZURE_COGNITIVE_SERVICES_API_KEY',
    );
    expect(DEFAULT_MODEL_PROVIDER_ENV_KEYS).toContain(
      'AZURE_COGNITIVE_SERVICES_RESOURCE_NAME',
    );
    expect(DEFAULT_MODEL_PROVIDER_ENV_KEYS).toContain('REQUESTY_API_KEY');
    expect(DEFAULT_MODEL_PROVIDER_ENV_KEYS).toContain('BASETEN_API_KEY');
    expect(DEFAULT_MODEL_PROVIDER_ENV_KEYS).toContain('TOGETHER_API_KEY');
    expect(DEFAULT_MODEL_PROVIDER_ENV_KEYS).toContain(
      'GOOGLE_GENERATIVE_AI_API_KEY',
    );
    expect(DEFAULT_MODEL_PROVIDER_ENV_KEYS).toContain(
      'AWS_BEARER_TOKEN_BEDROCK',
    );
    expect(DEFAULT_MODEL_PROVIDER_ENV_KEYS).toContain('AWS_REGION');
    expect(DEFAULT_MODEL_PROVIDER_ENV_KEYS).not.toContain(
      'GOOGLE_APPLICATION_CREDENTIALS',
    );
    expect(DEFAULT_MODEL_PROVIDER_ENV_KEYS).not.toContain(
      'GOOGLE_VERTEX_PROJECT',
    );
    expect(DEFAULT_MODEL_PROVIDER_ENV_KEYS).not.toContain(
      'GOOGLE_VERTEX_LOCATION',
    );
    expect(DEFAULT_MODEL_PROVIDER_ENV_KEYS).not.toContain('MISTRAL_API_KEY');
    expect(DEFAULT_MODEL_PROVIDER_ENV_KEYS).toContain('GEMINI_API_KEY');
    expect(DEFAULT_MODEL_PROVIDER_ENV_KEYS).toContain('ZAI_API_KEY');
    expect(DEFAULT_MODEL_PROVIDER_ENV_KEYS).toContain('ZAI_REGION');
    expect(DEFAULT_MODEL_PROVIDER_ENV_KEYS).toContain(
      'ZAI_CODING_PLAN_API_KEY',
    );
    expect(DEFAULT_MODEL_PROVIDER_ENV_KEYS).toContain('ZAI_CODING_PLAN_REGION');
    expect(DEFAULT_MODEL_PROVIDER_CREDENTIAL_ENV_VAR_NAMES).toContain(
      'ZAI_API_KEY',
    );
    expect(DEFAULT_MODEL_PROVIDER_CREDENTIAL_ENV_VAR_NAMES).not.toContain(
      'ZAI_REGION',
    );
    expect(DEFAULT_MODEL_PROVIDER_ENV_KEYS).not.toContain('GITHUB_TOKEN');
    // Ambient AWS access keys are intentionally NOT forwarded by default so a
    // controller's own infrastructure credentials never leak into sandboxes;
    // operators opt in with R_MODEL_ENV_KEYS.
    expect(DEFAULT_MODEL_PROVIDER_ENV_KEYS).not.toContain('AWS_ACCESS_KEY_ID');
    expect(DEFAULT_MODEL_PROVIDER_ENV_KEYS).not.toContain(
      'AWS_SECRET_ACCESS_KEY',
    );
  });

  it('distinguishes provider credentials from non-secret configuration', () => {
    expect(DEFAULT_MODEL_PROVIDER_CREDENTIAL_ENV_VAR_NAMES).toContain(
      'AWS_BEARER_TOKEN_BEDROCK',
    );
    expect(DEFAULT_MODEL_PROVIDER_CREDENTIAL_ENV_VAR_NAMES).toContain(
      'ANTHROPIC_API_KEY',
    );
    expect(DEFAULT_MODEL_PROVIDER_CREDENTIAL_ENV_VAR_NAMES).not.toContain(
      'AWS_REGION',
    );
    expect(DEFAULT_MODEL_PROVIDER_CREDENTIAL_ENV_VAR_NAMES).toContain(
      'AZURE_API_KEY',
    );
    expect(DEFAULT_MODEL_PROVIDER_CREDENTIAL_ENV_VAR_NAMES).not.toContain(
      'AZURE_RESOURCE_NAME',
    );
    expect(DEFAULT_MODEL_PROVIDER_CREDENTIAL_ENV_VAR_NAMES).toContain(
      'AZURE_COGNITIVE_SERVICES_API_KEY',
    );
    expect(DEFAULT_MODEL_PROVIDER_CREDENTIAL_ENV_VAR_NAMES).not.toContain(
      'AZURE_COGNITIVE_SERVICES_RESOURCE_NAME',
    );
  });
});

describe('reasoning effort labels', () => {
  it('exposes shared labels in the expected order', () => {
    expect(REASONING_EFFORT_OPTIONS).toEqual([
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'Extra high' },
      { value: 'max', label: 'Max' },
    ]);
  });

  it('returns the shared label for a reasoning effort', () => {
    expect(getReasoningEffortLabel('high')).toBe('High');
    expect(getReasoningEffortLabel('max')).toBe('Max');
  });
});

describe('buildSetupModelStatus', () => {
  it('treats runtime env as the highest-precedence satisfied setup source', () => {
    const status = buildSetupModelStatus({
      runtimeEnv: {
        R_MODEL: 'openai/gpt-5.4',
        OPENAI_API_KEY: 'sk-runtime',
      },
      persistedModelConfig: {
        roomoteModel: 'anthropic/claude-sonnet-4',
        roomoteSmallModel: null,
        roomoteVisionModel: null,
      },
      persistedEnvVarNames: ['ANTHROPIC_API_KEY'],
      selectedProvider: 'anthropic',
    });

    expect(status.setupSatisfiedByRuntimeEnv).toBe(true);
    expect(status.setupSatisfied).toBe(true);
    expect(status.runtimeRoomoteModelSatisfied).toBe(true);
    expect(status.runtimeProviderId).toBe('openai');
    expect(status.preselectedProvider).toBe('openai');
    expect(
      status.providers.find((provider) => provider.id === 'openai'),
    ).toMatchObject({
      runtimeApiKeySatisfied: true,
      savedApiKeySatisfied: false,
    });
  });

  it('preselects the saved provider when only persisted setup state exists', () => {
    const status = buildSetupModelStatus({
      persistedModelConfig: {
        roomoteModel: DEFAULT_TASK_MODEL_ID,
        roomoteSmallModel: null,
        roomoteVisionModel: null,
      },
      persistedEnvVarNames: ['OPENROUTER_API_KEY'],
    });

    expect(status.setupSatisfiedByRuntimeEnv).toBe(false);
    expect(status.setupSatisfied).toBe(true);
    expect(status.runtimeRoomoteModelSatisfied).toBe(false);
    expect(status.persistedProviderId).toBe('openrouter');
    expect(status.preselectedProvider).toBe('openrouter');
    expect(
      status.providers.find((provider) => provider.id === 'openrouter'),
    ).toMatchObject({
      runtimeApiKeySatisfied: false,
      savedApiKeySatisfied: true,
    });
  });

  it('does not treat a persisted model without a saved key as satisfied', () => {
    const status = buildSetupModelStatus({
      persistedModelConfig: {
        roomoteModel: DEFAULT_TASK_MODEL_ID,
        roomoteSmallModel: null,
        roomoteVisionModel: null,
      },
      persistedEnvVarNames: [],
    });

    expect(status.setupSatisfiedByRuntimeEnv).toBe(false);
    expect(status.setupSatisfied).toBe(false);
    expect(status.persistedProviderId).toBe('openrouter');
  });

  it('treats a persisted model with a runtime-env key as satisfied', () => {
    const status = buildSetupModelStatus({
      runtimeEnv: {
        OPENROUTER_API_KEY: 'sk-runtime',
      },
      persistedModelConfig: {
        roomoteModel: DEFAULT_TASK_MODEL_ID,
        roomoteSmallModel: null,
        roomoteVisionModel: null,
      },
      persistedEnvVarNames: [],
    });

    expect(status.setupSatisfiedByRuntimeEnv).toBe(false);
    expect(status.setupSatisfied).toBe(true);
  });

  it('resolves the vercel provider from a runtime AI Gateway model id', () => {
    const status = buildSetupModelStatus({
      runtimeEnv: {
        R_MODEL: 'vercel/anthropic/claude-sonnet-4',
        AI_GATEWAY_API_KEY: 'vck-runtime',
      },
    });

    expect(status.runtimeProviderId).toBe('vercel');
    expect(status.preselectedProvider).toBe('vercel');
    expect(status.setupSatisfiedByRuntimeEnv).toBe(true);
    expect(status.setupSatisfied).toBe(true);
    expect(
      status.providers.find((provider) => provider.id === 'vercel'),
    ).toMatchObject({
      runtimeApiKeySatisfied: true,
      savedApiKeySatisfied: false,
    });
  });

  it('marks the ChatGPT provider connected when chatgptConnected is true', () => {
    const status = buildSetupModelStatus({
      chatgptConnected: true,
      persistedEnvVarNames: [],
    });

    expect(status.chatgptConnected).toBe(true);
    expect(
      status.providers.find((provider) => provider.id === 'chatgpt'),
    ).toMatchObject({
      authKind: 'oauth',
      runtimeApiKeySatisfied: false,
      savedApiKeySatisfied: true,
    });
  });

  it('treats a persisted openai/ model as satisfied when ChatGPT is connected', () => {
    const status = buildSetupModelStatus({
      chatgptConnected: true,
      persistedModelConfig: {
        roomoteModel: 'openai/gpt-5.4',
        roomoteSmallModel: null,
        roomoteVisionModel: null,
      },
      persistedEnvVarNames: [],
    });

    expect(status.persistedProviderId).toBe('openai');
    expect(status.setupSatisfied).toBe(true);
    expect(status.chatgptConnected).toBe(true);
  });

  it('treats a runtime openai/ model as satisfied when ChatGPT is connected', () => {
    const status = buildSetupModelStatus({
      runtimeEnv: { R_MODEL: 'openai/gpt-5.4' },
      chatgptConnected: true,
    });

    expect(status.runtimeProviderId).toBe('openai');
    expect(status.setupSatisfiedByRuntimeEnv).toBe(true);
    expect(status.setupSatisfied).toBe(true);
  });

  it('flags both-configured when OPENAI_API_KEY and ChatGPT are present', () => {
    const status = buildSetupModelStatus({
      runtimeEnv: { OPENAI_API_KEY: 'sk-runtime' },
      chatgptConnected: true,
    });

    expect(status.openaiAndChatGptBothConfigured).toBe(true);
  });

  it('does not flag both-configured when only ChatGPT is connected', () => {
    const status = buildSetupModelStatus({
      chatgptConnected: true,
      persistedEnvVarNames: [],
    });

    expect(status.openaiAndChatGptBothConfigured).toBe(false);
  });

  it('resolves the requesty provider from a runtime Requesty model id', () => {
    const status = buildSetupModelStatus({
      runtimeEnv: {
        R_MODEL: 'requesty/claude-sonnet-5',
        REQUESTY_API_KEY: 'rty-runtime',
      },
    });

    expect(status.runtimeProviderId).toBe('requesty');
    expect(status.preselectedProvider).toBe('requesty');
    expect(status.setupSatisfiedByRuntimeEnv).toBe(true);
    expect(status.setupSatisfied).toBe(true);
    expect(
      status.providers.find((provider) => provider.id === 'requesty'),
    ).toMatchObject({
      runtimeApiKeySatisfied: true,
      savedApiKeySatisfied: false,
    });
  });

  it('resolves the baseten provider from a runtime Baseten model id', () => {
    const status = buildSetupModelStatus({
      runtimeEnv: {
        R_MODEL: 'baseten/moonshotai/Kimi-K2.7-Code',
        BASETEN_API_KEY: 'btn-runtime',
      },
    });

    expect(status.runtimeProviderId).toBe('baseten');
    expect(status.preselectedProvider).toBe('baseten');
    expect(status.setupSatisfiedByRuntimeEnv).toBe(true);
    expect(status.setupSatisfied).toBe(true);
    expect(
      status.providers.find((provider) => provider.id === 'baseten'),
    ).toMatchObject({
      runtimeApiKeySatisfied: true,
      savedApiKeySatisfied: false,
    });
  });

  it('resolves the togetherai provider from a runtime Together AI model id', () => {
    const status = buildSetupModelStatus({
      runtimeEnv: {
        R_MODEL: 'togetherai/deepseek-ai/DeepSeek-V4-Pro',
        TOGETHER_API_KEY: 'tgr-runtime',
      },
    });

    expect(status.runtimeProviderId).toBe('togetherai');
    expect(status.preselectedProvider).toBe('togetherai');
    expect(status.setupSatisfiedByRuntimeEnv).toBe(true);
    expect(status.setupSatisfied).toBe(true);
    expect(
      status.providers.find((provider) => provider.id === 'togetherai'),
    ).toMatchObject({
      runtimeApiKeySatisfied: true,
      savedApiKeySatisfied: false,
    });
  });

  it('prefixes bare LiteLLM route names when LITELLM_BASE_URL is configured', () => {
    const status = buildSetupModelStatus({
      runtimeEnv: {
        R_MODEL: 'coding',
        LITELLM_BASE_URL: 'http://localhost:4000',
        LITELLM_API_KEY: 'litellm-key',
      },
    });

    expect(status.runtimeRoomoteModel).toBe('litellm/coding');
    expect(status.runtimeProviderId).toBe('litellm');
    expect(status.preselectedProvider).toBe('litellm');
    expect(status.setupSatisfiedByRuntimeEnv).toBe(true);
    expect(status.setupSatisfied).toBe(true);
    expect(
      status.providers.find((provider) => provider.id === 'litellm'),
    ).toMatchObject({
      runtimeApiKeySatisfied: true,
      savedApiKeySatisfied: false,
    });
  });

  it('prefixes bare LiteLLM route names when LiteLLM is only persisted', () => {
    const status = buildSetupModelStatus({
      runtimeEnv: {
        R_MODEL: 'coding',
      },
      persistedEnvVarNames: ['LITELLM_BASE_URL', 'LITELLM_API_KEY'],
      persistedEnvVarValues: {
        LITELLM_BASE_URL: 'http://localhost:4000',
      },
    });

    expect(status.runtimeRoomoteModel).toBe('litellm/coding');
    expect(status.runtimeProviderId).toBe('litellm');
    expect(status.setupSatisfiedByRuntimeEnv).toBe(false);
    expect(status.setupSatisfied).toBe(true);
  });
});

describe('buildSetupModelStatus multi-credential providers', () => {
  it('does not require optional additional env vars for satisfaction', () => {
    const status = buildSetupModelStatus({
      runtimeEnv: {
        AWS_BEARER_TOKEN_BEDROCK: 'bedrock-key',
      },
    });

    expect(
      status.providers.find((provider) => provider.id === 'amazon-bedrock'),
    ).toMatchObject({
      runtimeApiKeySatisfied: true,
      savedApiKeySatisfied: false,
    });
  });

  it('exposes non-secret additional env values without exposing primary credentials', () => {
    const status = buildSetupModelStatus({
      runtimeEnv: {
        AWS_BEARER_TOKEN_BEDROCK: 'runtime-bedrock-key',
      },
      persistedEnvVarNames: ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION'],
      persistedEnvVarValues: { AWS_REGION: 'us-west-2' },
    });

    expect(
      status.providers.find((provider) => provider.id === 'amazon-bedrock'),
    ).toMatchObject({
      additionalEnvValues: { AWS_REGION: 'us-west-2' },
    });
    expect(
      status.providers.find((provider) => provider.id === 'amazon-bedrock')
        ?.additionalEnvValues,
    ).not.toHaveProperty('AWS_BEARER_TOKEN_BEDROCK');
  });

  it('treats a persisted Bedrock Mantle model with saved credentials as satisfied', () => {
    const status = buildSetupModelStatus({
      persistedModelConfig: {
        roomoteModel: 'bedrock-mantle/anthropic.claude-sonnet-5',
      },
      persistedEnvVarNames: ['AWS_BEARER_TOKEN_BEDROCK'],
    });

    expect(status.persistedProviderId).toBe('amazon-bedrock');
    expect(status.setupSatisfied).toBe(true);
  });
});

describe('collectSetupModelProviderCredentialValues', () => {
  const bedrockProvider = SETUP_MODEL_PROVIDER_CATALOG.find(
    (provider) => provider.id === 'amazon-bedrock',
  )!;
  const anthropicProvider = SETUP_MODEL_PROVIDER_CATALOG.find(
    (provider) => provider.id === 'anthropic',
  )!;

  it('collects the primary key and trimmed additional values', () => {
    expect(
      collectSetupModelProviderCredentialValues({
        provider: bedrockProvider,
        apiKey: ' bedrock-key ',
        additionalEnvValues: { AWS_REGION: ' us-west-2 ' },
        isEnvVarSatisfied: () => false,
        action: 'save it',
      }),
    ).toEqual({
      values: [
        { name: 'AWS_BEARER_TOKEN_BEDROCK', value: 'bedrock-key' },
        { name: 'AWS_REGION', value: 'us-west-2' },
      ],
      clearedEnvVarNames: [],
    });
  });

  it('marks explicitly blanked optional values as cleared', () => {
    expect(
      collectSetupModelProviderCredentialValues({
        provider: bedrockProvider,
        apiKey: 'bedrock-key',
        additionalEnvValues: { AWS_REGION: '  ' },
        isEnvVarSatisfied: () => false,
        action: 'save it',
      }),
    ).toEqual({
      values: [{ name: 'AWS_BEARER_TOKEN_BEDROCK', value: 'bedrock-key' }],
      clearedEnvVarNames: ['AWS_REGION'],
    });
  });

  it('does not clear optional fields that were not submitted', () => {
    expect(
      collectSetupModelProviderCredentialValues({
        provider: bedrockProvider,
        apiKey: 'bedrock-key',
        isEnvVarSatisfied: () => false,
        action: 'save it',
      }),
    ).toEqual({
      values: [{ name: 'AWS_BEARER_TOKEN_BEDROCK', value: 'bedrock-key' }],
      clearedEnvVarNames: [],
    });
  });

  it('uses the provider credential label when the primary value is missing', () => {
    expect(() =>
      collectSetupModelProviderCredentialValues({
        provider: anthropicProvider,
        isEnvVarSatisfied: () => false,
        action: 'save it',
      }),
    ).toThrow('Enter your Anthropic API key to save it.');
  });

  it('rejects values for env vars the provider does not declare', () => {
    expect(() =>
      collectSetupModelProviderCredentialValues({
        provider: bedrockProvider,
        apiKey: 'bedrock-key',
        additionalEnvValues: { DATABASE_URL: 'nope' },
        isEnvVarSatisfied: () => false,
        action: 'save it',
      }),
    ).toThrow('Amazon Bedrock does not accept a DATABASE_URL value.');
  });

  it('ignores the primary endpoint env var when present in additionalEnvValues', () => {
    const openaiCompatibleProvider = SETUP_MODEL_PROVIDER_CATALOG.find(
      (provider) => provider.id === 'openai-compatible',
    )!;

    expect(
      collectSetupModelProviderCredentialValues({
        provider: openaiCompatibleProvider,
        apiKey: 'https://proxy.example.com/v1',
        additionalEnvValues: {
          OPENAI_COMPATIBLE_BASE_URL: 'https://stale.example.com/v1',
          OPENAI_COMPATIBLE_API_KEY: 'optional-key',
        },
        isEnvVarSatisfied: () => false,
        action: 'save it',
      }),
    ).toEqual({
      values: [
        {
          name: 'OPENAI_COMPATIBLE_BASE_URL',
          value: 'https://proxy.example.com/v1',
        },
        { name: 'OPENAI_COMPATIBLE_API_KEY', value: 'optional-key' },
      ],
      clearedEnvVarNames: [],
    });
  });

  it('still rejects a primary API-key env var submitted via additionalEnvValues', () => {
    expect(() =>
      collectSetupModelProviderCredentialValues({
        provider: anthropicProvider,
        apiKey: 'sk-ant-main',
        additionalEnvValues: { ANTHROPIC_API_KEY: 'sk-ant-extra' },
        isEnvVarSatisfied: () => false,
        action: 'save it',
      }),
    ).toThrow('Anthropic does not accept a ANTHROPIC_API_KEY value.');
  });

  it('accepts a listed option value for selectable fields', () => {
    const zaiProvider = SETUP_MODEL_PROVIDER_CATALOG.find(
      (provider) => provider.id === 'zai',
    )!;

    expect(
      collectSetupModelProviderCredentialValues({
        provider: zaiProvider,
        apiKey: 'zai-key',
        additionalEnvValues: { ZAI_REGION: 'china' },
        isEnvVarSatisfied: () => false,
        action: 'save it',
      }),
    ).toEqual({
      values: [
        { name: 'ZAI_API_KEY', value: 'zai-key' },
        { name: 'ZAI_REGION', value: 'china' },
      ],
      clearedEnvVarNames: [],
    });
  });

  it('rejects a value not in options for selectable fields', () => {
    const zaiProvider = SETUP_MODEL_PROVIDER_CATALOG.find(
      (provider) => provider.id === 'zai',
    )!;

    expect(() =>
      collectSetupModelProviderCredentialValues({
        provider: zaiProvider,
        apiKey: 'zai-key',
        additionalEnvValues: { ZAI_REGION: 'us-east-1' },
        isEnvVarSatisfied: () => false,
        action: 'save it',
      }),
    ).toThrow('Enter a valid Region for Z.AI to save it.');
  });
});
