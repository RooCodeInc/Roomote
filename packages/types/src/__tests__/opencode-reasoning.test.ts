import {
  buildOpenCodeModelReasoningOptions,
  mergeOpenCodeModelReasoningOptions,
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
