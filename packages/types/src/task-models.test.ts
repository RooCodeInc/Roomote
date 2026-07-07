import {
  buildTaskModelOption,
  DEFAULT_TASK_MODEL_SETTINGS,
  getDefaultTaskModelId,
  getEnabledTaskModels,
  getTaskModelCatalog,
  getTaskModelProviderId,
  normalizeTaskModelId,
  normalizeTaskModelSettings,
} from './task-models';

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
      normalizeTaskModelId('amazon-bedrock/global.anthropic.claude-sonnet-5'),
    ).toBe('amazon-bedrock/global.anthropic.claude-sonnet-5');
    expect(normalizeTaskModelId('google-vertex/gemini-3.5-flash')).toBe(
      'google-vertex/gemini-3.5-flash',
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
      allowedModelIds: ['openrouter/openai/gpt-5.5'],
      defaultModelId: 'openrouter/openai/gpt-chat-latest',
    });

    expect(settings).toEqual({
      models: DEFAULT_TASK_MODEL_SETTINGS.models,
      allowedModelIds: ['openrouter/openai/gpt-5.5'],
      defaultModelId: 'openrouter/openai/gpt-5.5',
    });
  });

  it('uses only enabled models when building launch options', () => {
    const settings = {
      models: DEFAULT_TASK_MODEL_SETTINGS.models,
      allowedModelIds: [
        'openrouter/openai/gpt-5.5',
        'openrouter/anthropic/claude-sonnet-5',
      ],
      defaultModelId: 'openrouter/openai/gpt-5.5',
    };

    expect(getEnabledTaskModels(settings).map((model) => model.id)).toEqual([
      'openrouter/openai/gpt-5.5',
      'openrouter/anthropic/claude-sonnet-5',
    ]);
    expect(getDefaultTaskModelId(settings)).toBe('openrouter/openai/gpt-5.5');
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
});
