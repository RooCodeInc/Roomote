import {
  buildOpenCodeModelReasoningOptions,
  mergeOpenCodeModelReasoningOptions,
  stripOpenCodeModelReasoningOptions,
} from '../opencode-reasoning';

describe('buildOpenCodeModelReasoningOptions', () => {
  it('uses the OpenRouter reasoning shape for openrouter models', () => {
    expect(
      buildOpenCodeModelReasoningOptions(
        'openrouter/anthropic/claude-sonnet-4',
        'high',
      ),
    ).toEqual({ reasoning: { effort: 'high' } });
  });

  it('passes xhigh through for OpenAI-style OpenRouter models', () => {
    expect(
      buildOpenCodeModelReasoningOptions('openrouter/openai/gpt-5.4', 'xhigh'),
    ).toEqual({ reasoning: { effort: 'xhigh' } });
  });

  it('passes max through for OpenAI-style OpenRouter models', () => {
    expect(
      buildOpenCodeModelReasoningOptions('openrouter/openai/gpt-5.4', 'max'),
    ).toEqual({ reasoning: { effort: 'max' } });
  });

  it('clamps xhigh to high for non-OpenAI OpenRouter models', () => {
    expect(
      buildOpenCodeModelReasoningOptions(
        'openrouter/anthropic/claude-sonnet-4',
        'xhigh',
      ),
    ).toEqual({ reasoning: { effort: 'high' } });
  });

  it('maps pre-adaptive Anthropic models to extended-thinking budgets', () => {
    expect(
      buildOpenCodeModelReasoningOptions('anthropic/claude-sonnet-4', 'high'),
    ).toEqual({
      thinking: { type: 'enabled', budgetTokens: 16_000 },
    });
    expect(
      buildOpenCodeModelReasoningOptions(
        'anthropic/claude-sonnet-4-5-20250929',
        'medium',
      ),
    ).toEqual({
      thinking: { type: 'enabled', budgetTokens: 8_000 },
    });
    expect(
      buildOpenCodeModelReasoningOptions('anthropic/claude-haiku-4-5', 'low'),
    ).toEqual({
      thinking: { type: 'enabled', budgetTokens: 4_000 },
    });
    expect(
      buildOpenCodeModelReasoningOptions('anthropic/claude-opus-4-5', 'high'),
    ).toEqual({
      thinking: { type: 'enabled', budgetTokens: 16_000 },
    });
  });

  it('maps adaptive-thinking Anthropic models to adaptive with effort', () => {
    expect(
      buildOpenCodeModelReasoningOptions('anthropic/claude-sonnet-5', 'xhigh'),
    ).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      effort: 'xhigh',
    });
    expect(
      buildOpenCodeModelReasoningOptions('anthropic/claude-opus-4-8', 'high'),
    ).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      effort: 'high',
    });
    expect(
      buildOpenCodeModelReasoningOptions('anthropic/claude-fable-5', 'medium'),
    ).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      effort: 'medium',
    });
    expect(
      buildOpenCodeModelReasoningOptions('anthropic/claude-opus-4-7', 'max'),
    ).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      effort: 'max',
    });
  });

  it('clamps xhigh to high for the Anthropic 4.6 family', () => {
    expect(
      buildOpenCodeModelReasoningOptions('anthropic/claude-opus-4-6', 'xhigh'),
    ).toEqual({
      thinking: { type: 'adaptive' },
      effort: 'high',
    });
    expect(
      buildOpenCodeModelReasoningOptions('anthropic/claude-sonnet-4-6', 'high'),
    ).toEqual({
      thinking: { type: 'adaptive' },
      effort: 'high',
    });
    expect(
      buildOpenCodeModelReasoningOptions('anthropic/claude-sonnet-4-6', 'max'),
    ).toEqual({
      thinking: { type: 'adaptive' },
      effort: 'max',
    });
  });

  it('maps Bedrock Mantle models like the Anthropic provider', () => {
    expect(
      buildOpenCodeModelReasoningOptions(
        'bedrock-mantle/anthropic.claude-sonnet-5',
        'high',
      ),
    ).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      effort: 'high',
    });
    expect(
      buildOpenCodeModelReasoningOptions(
        'bedrock-mantle/anthropic.claude-haiku-4-5',
        'high',
      ),
    ).toEqual({
      thinking: { type: 'enabled', budgetTokens: 16_000 },
    });
  });

  it('maps native Bedrock Claude models like the Anthropic provider', () => {
    expect(
      buildOpenCodeModelReasoningOptions(
        'amazon-bedrock/eu.anthropic.claude-sonnet-5',
        'high',
      ),
    ).toEqual({
      reasoningConfig: {
        type: 'adaptive',
        maxReasoningEffort: 'high',
        display: 'summarized',
      },
    });
    expect(
      buildOpenCodeModelReasoningOptions(
        'amazon-bedrock/anthropic.claude-haiku-4-5-20251001-v1:0',
        'high',
      ),
    ).toEqual({
      reasoningConfig: { type: 'enabled', budgetTokens: 16_000 },
    });
  });

  it('maps native Bedrock Nova reasoning to supported effort levels', () => {
    expect(
      buildOpenCodeModelReasoningOptions(
        'amazon-bedrock/us.amazon.nova-2-lite-v1:0',
        'medium',
      ),
    ).toEqual({
      reasoningConfig: { type: 'enabled', maxReasoningEffort: 'medium' },
    });
    expect(
      buildOpenCodeModelReasoningOptions(
        'amazon-bedrock/us.amazon.nova-2-lite-v1:0',
        'max',
      ),
    ).toEqual({
      reasoningConfig: { type: 'enabled', maxReasoningEffort: 'high' },
    });
    expect(
      buildOpenCodeModelReasoningOptions(
        'amazon-bedrock/meta.llama3-70b-instruct-v1:0',
        'medium',
      ),
    ).toBeNull();
  });

  it('maps Copilot Claude budget reasoning to thinking_budget', () => {
    expect(
      buildOpenCodeModelReasoningOptions(
        'github-copilot/claude-haiku-4.5',
        'medium',
      ),
    ).toEqual({ thinking_budget: 8_000 });
  });

  it('keeps reasoningEffort for Copilot models that support effort', () => {
    expect(
      buildOpenCodeModelReasoningOptions(
        'github-copilot/claude-sonnet-5',
        'high',
      ),
    ).toEqual({ reasoningEffort: 'high' });
    expect(
      buildOpenCodeModelReasoningOptions(
        'github-copilot/gpt-5.6-terra',
        'medium',
      ),
    ).toEqual({ reasoningEffort: 'medium' });
  });

  it('uses the generic reasoningEffort option for other providers', () => {
    expect(buildOpenCodeModelReasoningOptions('openai/gpt-5.4', 'low')).toEqual(
      { reasoningEffort: 'low' },
    );
    expect(
      buildOpenCodeModelReasoningOptions('vercel/openai/gpt-5.4', 'medium'),
    ).toEqual({ reasoningEffort: 'medium' });
    expect(buildOpenCodeModelReasoningOptions('openai/gpt-5.4', 'max')).toEqual(
      { reasoningEffort: 'max' },
    );
  });

  it('clamps LiteLLM xhigh reasoning to high', () => {
    expect(
      buildOpenCodeModelReasoningOptions('litellm/openai/gpt-5.4', 'xhigh'),
    ).toEqual({ reasoningEffort: 'high' });
  });

  it('returns null for malformed model ids', () => {
    expect(
      buildOpenCodeModelReasoningOptions('no-provider', 'high'),
    ).toBeNull();
    expect(buildOpenCodeModelReasoningOptions('trailing/', 'high')).toBeNull();
  });
});

describe('mergeOpenCodeModelReasoningOptions', () => {
  it('nests options under provider.models', () => {
    expect(
      mergeOpenCodeModelReasoningOptions(
        {},
        'openrouter/openai/gpt-5.4',
        'high',
      ),
    ).toEqual({
      openrouter: {
        models: {
          'openai/gpt-5.4': {
            options: { reasoning: { effort: 'high' } },
          },
        },
      },
    });
  });

  it('keeps existing entries for the same model', () => {
    const existing = mergeOpenCodeModelReasoningOptions(
      {},
      'openrouter/openai/gpt-5.4',
      'high',
    );

    expect(
      mergeOpenCodeModelReasoningOptions(
        existing,
        'openrouter/openai/gpt-5.4',
        'low',
      ),
    ).toEqual(existing);
  });

  it('merges additional models under the same provider', () => {
    const merged = mergeOpenCodeModelReasoningOptions(
      mergeOpenCodeModelReasoningOptions(
        {},
        'openrouter/openai/gpt-5.4',
        'high',
      ),
      'openrouter/z-ai/glm-5.2',
      'low',
    );

    expect(merged).toEqual({
      openrouter: {
        models: {
          'openai/gpt-5.4': {
            options: { reasoning: { effort: 'high' } },
          },
          'z-ai/glm-5.2': {
            options: { reasoning: { effort: 'low' } },
          },
        },
      },
    });
  });

  it('returns the input unchanged for malformed model ids', () => {
    expect(
      mergeOpenCodeModelReasoningOptions({}, 'no-provider', 'high'),
    ).toEqual({});
  });
});

describe('stripOpenCodeModelReasoningOptions', () => {
  it('removes every provider reasoning shape the builders can emit', () => {
    const merged = [
      'anthropic/claude-sonnet-5',
      'amazon-bedrock/anthropic.claude-sonnet-5-v1:0',
      'openrouter/z-ai/glm-5.2',
      'litellm/coding',
      'github-copilot/claude-3.7-sonnet-thought',
    ].reduce<Record<string, unknown>>(
      (config, modelId) =>
        mergeOpenCodeModelReasoningOptions(config, modelId, 'high'),
      {},
    );

    expect(stripOpenCodeModelReasoningOptions(merged)).toEqual({});
  });

  it('keeps non-reasoning model options and provider metadata intact', () => {
    expect(
      stripOpenCodeModelReasoningOptions({
        openai: {
          models: {
            'gpt-5.6-terra': {
              options: { reasoningEffort: 'high', serviceTier: 'priority' },
            },
          },
        },
        litellm: {
          npm: '@ai-sdk/openai-compatible',
          name: 'LiteLLM',
          options: { baseURL: 'https://litellm.example.com/v1' },
          models: {
            coding: { name: 'coding' },
          },
        },
      }),
    ).toEqual({
      openai: {
        models: {
          'gpt-5.6-terra': {
            options: { serviceTier: 'priority' },
          },
        },
      },
      litellm: {
        npm: '@ai-sdk/openai-compatible',
        name: 'LiteLLM',
        options: { baseURL: 'https://litellm.example.com/v1' },
        models: {
          coding: { name: 'coding' },
        },
      },
    });
  });

  it('prunes model, models, and provider entries emptied by the strip', () => {
    expect(
      stripOpenCodeModelReasoningOptions({
        anthropic: {
          models: {
            'claude-sonnet-5': {
              options: { thinking: { type: 'adaptive' }, effort: 'high' },
            },
            'claude-haiku-4-5': {
              name: 'claude-haiku-4-5',
              options: { thinking: { type: 'adaptive' } },
            },
          },
        },
      }),
    ).toEqual({
      anthropic: {
        models: {
          'claude-haiku-4-5': { name: 'claude-haiku-4-5' },
        },
      },
    });
  });

  it('passes malformed provider and model entries through unchanged', () => {
    expect(
      stripOpenCodeModelReasoningOptions({
        broken: 'not-an-object',
        listShaped: ['a'],
        noModels: { name: 'provider-without-models' },
        oddModels: { models: { entry: 'not-an-object' } },
      }),
    ).toEqual({
      broken: 'not-an-object',
      listShaped: ['a'],
      noModels: { name: 'provider-without-models' },
      oddModels: { models: { entry: 'not-an-object' } },
    });
  });
});
