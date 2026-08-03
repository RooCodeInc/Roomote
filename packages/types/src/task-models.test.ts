import {
  applyImplicitLiteLlmModelPrefix,
  buildTaskModelOption,
  DEFAULT_TASK_MODEL_SETTINGS,
  getDefaultTaskModelId,
  getEnabledTaskModels,
  getTaskModelCatalog,
  getTaskModelProviderId,
  isTaskModelIdDisabled,
  normalizeTaskModelId,
  normalizeTaskModelSettings,
} from './task-models';

describe('applyImplicitLiteLlmModelPrefix', () => {
  it('prefixes bare model names when LiteLLM is configured', () => {
    expect(
      applyImplicitLiteLlmModelPrefix(
        'qwen3.6-35b-a3b-uncensored-heretic-native-mtp-preserved-nvfp4-experts-only',
        true,
      ),
    ).toBe(
      'litellm/qwen3.6-35b-a3b-uncensored-heretic-native-mtp-preserved-nvfp4-experts-only',
    );
    expect(applyImplicitLiteLlmModelPrefix('  coding  ', true)).toBe(
      'litellm/coding',
    );
  });

  it('leaves qualified and bare ids unchanged when LiteLLM is not configured', () => {
    expect(applyImplicitLiteLlmModelPrefix('coding', false)).toBe('coding');
    expect(applyImplicitLiteLlmModelPrefix('litellm/coding', true)).toBe(
      'litellm/coding',
    );
    expect(
      applyImplicitLiteLlmModelPrefix('openrouter/openai/gpt-5.4', true),
    ).toBe('openrouter/openai/gpt-5.4');
  });
});

describe('normalizeTaskModelId', () => {
  it('prefixes bare author/model slugs with openrouter', () => {
    expect(normalizeTaskModelId('z-ai/glm-5.2')).toBe(
      'openrouter/z-ai/glm-5.2',
    );
    expect(normalizeTaskModelId('  z-ai/glm-5.2  ')).toBe(
      'openrouter/z-ai/glm-5.2',
    );
  });

  it('preserves direct-provider model ids without an openrouter prefix', () => {
    expect(normalizeTaskModelId('anthropic/claude-sonnet-4')).toBe(
      'anthropic/claude-sonnet-4',
    );
    expect(normalizeTaskModelId('openai/gpt-5.4')).toBe('openai/gpt-5.4');
    expect(normalizeTaskModelId('azure/gpt-5.6-terra')).toBe(
      'azure/gpt-5.6-terra',
    );
    expect(normalizeTaskModelId('azure-cognitive-services/gpt-5.6-terra')).toBe(
      'azure-cognitive-services/gpt-5.6-terra',
    );
    expect(normalizeTaskModelId('vercel/openai/gpt-5.4')).toBe(
      'vercel/openai/gpt-5.4',
    );
    expect(normalizeTaskModelId('requesty/openai/gpt-5.4')).toBe(
      'requesty/openai/gpt-5.4',
    );
    expect(normalizeTaskModelId('baseten/moonshotai/Kimi-K2.7-Code')).toBe(
      'baseten/moonshotai/Kimi-K2.7-Code',
    );
    expect(normalizeTaskModelId('togetherai/deepseek-ai/DeepSeek-V4-Pro')).toBe(
      'togetherai/deepseek-ai/DeepSeek-V4-Pro',
    );
    expect(normalizeTaskModelId('opencode/big-pickle')).toBe(
      'opencode/big-pickle',
    );
    expect(
      normalizeTaskModelId('bedrock-mantle/anthropic.claude-sonnet-5'),
    ).toBe('bedrock-mantle/anthropic.claude-sonnet-5');
    expect(normalizeTaskModelId('google-vertex/gemini-3.5-flash')).toBe(
      'google-vertex/gemini-3.5-flash',
    );
    expect(normalizeTaskModelId('mistral/mistral-large-latest')).toBe(
      'mistral/mistral-large-latest',
    );
    expect(normalizeTaskModelId('google/gemini-3.5-flash')).toBe(
      'google/gemini-3.5-flash',
    );
  });

  it('leaves fully-qualified openrouter ids unchanged', () => {
    expect(normalizeTaskModelId('openrouter/openai/gpt-5.4')).toBe(
      'openrouter/openai/gpt-5.4',
    );
  });
});

describe('getTaskModelProviderId', () => {
  it('returns the provider prefix of a model id', () => {
    expect(getTaskModelProviderId('openrouter/openai/gpt-5.4')).toBe(
      'openrouter',
    );
    expect(getTaskModelProviderId('anthropic/claude-sonnet-4')).toBe(
      'anthropic',
    );
    expect(getTaskModelProviderId('')).toBeNull();
  });

  it('identifies disabled direct-provider model ids', () => {
    expect(isTaskModelIdDisabled('google-vertex/gemini-3.5-flash')).toBe(true);
    expect(isTaskModelIdDisabled('mistral/mistral-large-latest')).toBe(true);
    expect(isTaskModelIdDisabled('openrouter/mistralai/mistral-large')).toBe(
      false,
    );
    expect(isTaskModelIdDisabled('google/gemini-3.5-flash')).toBe(false);
  });
});

describe('task model settings', () => {
  it('falls back to the shipped defaults when settings are empty', () => {
    expect(normalizeTaskModelSettings(null)).toEqual(
      DEFAULT_TASK_MODEL_SETTINGS,
    );
  });

  it('repairs an invalid default to the first enabled model', () => {
    const settings = normalizeTaskModelSettings({
      models: DEFAULT_TASK_MODEL_SETTINGS.models,
      allowedModelIds: ['openrouter/openai/gpt-5.6-terra'],
      defaultModelId: 'openrouter/openai/gpt-chat-latest',
    });

    expect(settings).toEqual({
      models: DEFAULT_TASK_MODEL_SETTINGS.models,
      allowedModelIds: ['openrouter/openai/gpt-5.6-terra'],
      defaultModelId: 'openrouter/openai/gpt-5.6-terra',
    });
  });

  it('migrates persisted OpenCode DeepSeek Flash model settings', () => {
    const settings = normalizeTaskModelSettings({
      models: [
        {
          id: 'opencode/deepseek-v4-flash-0731',
          displayName: 'DeepSeek V4 Flash 0731',
          family: 'DeepSeek',
        },
      ],
      allowedModelIds: ['opencode/deepseek-v4-flash-0731'],
      defaultModelId: 'opencode/deepseek-v4-flash-0731',
    });

    expect(settings).toEqual({
      models: [
        {
          id: 'opencode/deepseek-v4-flash',
          displayName: 'DeepSeek V4 Flash 0731',
          family: 'DeepSeek',
        },
      ],
      allowedModelIds: ['opencode/deepseek-v4-flash'],
      defaultModelId: 'opencode/deepseek-v4-flash',
    });
  });

  it('uses only enabled models when building launch options', () => {
    const settings = {
      models: DEFAULT_TASK_MODEL_SETTINGS.models,
      allowedModelIds: [
        'openrouter/openai/gpt-5.6-terra',
        'openrouter/anthropic/claude-sonnet-5',
      ],
      defaultModelId: 'openrouter/openai/gpt-5.6-terra',
    };

    expect(getEnabledTaskModels(settings).map((model) => model.id)).toEqual([
      'openrouter/openai/gpt-5.6-terra',
      'openrouter/anthropic/claude-sonnet-5',
    ]);
    expect(getDefaultTaskModelId(settings)).toBe(
      'openrouter/openai/gpt-5.6-terra',
    );
  });

  it('preserves custom models in the available catalog', () => {
    const settings = normalizeTaskModelSettings({
      models: [
        buildTaskModelOption({
          id: 'openrouter/openai/gpt-5.5',
          displayName: 'GPT 5.5',
          family: 'GPT',
        }),
        buildTaskModelOption({
          id: 'openrouter/openai/gpt-5.6',
          displayName: 'GPT 5.6',
        }),
      ],
      allowedModelIds: ['openrouter/openai/gpt-5.6'],
      defaultModelId: 'openrouter/openai/gpt-5.6',
    });

    expect(getTaskModelCatalog(settings).map((model) => model.id)).toEqual([
      'openrouter/openai/gpt-5.5',
      'openrouter/openai/gpt-5.6',
    ]);
    expect(getEnabledTaskModels(settings).map((model) => model.id)).toEqual([
      'openrouter/openai/gpt-5.6',
    ]);
  });

  it('removes disabled direct-provider models from persisted settings', () => {
    const settings = normalizeTaskModelSettings({
      models: [
        buildTaskModelOption({
          id: 'google-vertex/gemini-3.5-flash',
          displayName: 'Gemini 3.5 Flash on Vertex',
        }),
        buildTaskModelOption({
          id: 'mistral/mistral-large-latest',
          displayName: 'Mistral Large',
        }),
      ],
      allowedModelIds: [
        'google-vertex/gemini-3.5-flash',
        'mistral/mistral-large-latest',
      ],
      defaultModelId: 'google-vertex/gemini-3.5-flash',
    });

    expect(settings.models).toEqual(DEFAULT_TASK_MODEL_SETTINGS.models);
    expect(settings.allowedModelIds).toHaveLength(1);
    expect(settings.allowedModelIds[0]).not.toMatch(/^google-vertex\//u);
    expect(settings.allowedModelIds[0]).not.toMatch(/^mistral\//u);
    expect(settings.defaultModelId).not.toMatch(/^google-vertex\//u);
  });
});
