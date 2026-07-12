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

  it('maps Anthropic direct models to extended-thinking budgets', () => {
    expect(
      buildOpenCodeModelReasoningOptions('anthropic/claude-sonnet-4', 'high'),
    ).toEqual({
      thinking: { type: 'enabled', budgetTokens: 16_000 },
    });
  });

  it('maps Bedrock Mantle models to Anthropic extended-thinking budgets', () => {
    expect(
      buildOpenCodeModelReasoningOptions(
        'bedrock-mantle/anthropic.claude-sonnet-5',
        'high',
      ),
    ).toEqual({
      thinking: { type: 'enabled', budgetTokens: 16_000 },
    });
  });

  it('uses the generic reasoningEffort option for other providers', () => {
    expect(buildOpenCodeModelReasoningOptions('openai/gpt-5.4', 'low')).toEqual(
      { reasoningEffort: 'low' },
    );
    expect(
      buildOpenCodeModelReasoningOptions('vercel/openai/gpt-5.4', 'medium'),
    ).toEqual({ reasoningEffort: 'medium' });
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
