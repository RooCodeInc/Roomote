import {
  MODEL_FAST_MODE_CAPABILITIES,
  mergeOpenCodeModelFastModeOptions,
  resolveModelFastModeRequestOptions,
  validateModelFastModeResponse,
} from './model-fast-mode';

describe('model Fast mode capabilities', () => {
  it('keeps ChatGPT OAuth and OpenAI API capabilities distinct by route', () => {
    expect(
      MODEL_FAST_MODE_CAPABILITIES.filter(
        (capability) => capability.authKind === 'chatgpt-oauth',
      ),
    ).toHaveLength(9);
    const openAiApiModelIds = MODEL_FAST_MODE_CAPABILITIES.filter(
      (capability) => capability.authKind === 'openai-api-key',
    ).map((capability) => capability.modelId);
    expect(openAiApiModelIds).toHaveLength(21);
    expect(openAiApiModelIds).toContain('openai/gpt-6-astra');
    expect(openAiApiModelIds).toContain('openai/gpt-5.6-luna');
    expect(openAiApiModelIds).toContain('openai/o4-mini');
  });

  it('inherits ChatGPT account Fast mode while allowing a Normal model override', () => {
    const options = resolveModelFastModeRequestOptions({
      authKind: 'chatgpt-oauth',
      chatgptAccountFastMode: true,
      overrides: { 'openai:chatgpt-oauth:gpt-6-astra:responses': 'normal' },
    });

    expect(options['openai/gpt-6-astra']).toBe('default');
    expect(options['openai/gpt-6-sol']).toBe('priority');
    expect(options['openai/gpt-5.4']).toBe('priority');
  });

  it('leaves OpenAI project inheritance unset and applies only API-key overrides', () => {
    const options = resolveModelFastModeRequestOptions({
      authKind: 'openai-api-key',
      overrides: {
        'openai:openai-api-key:gpt-6-astra:responses': 'fast',
        'openai:openai-api-key:gpt-6-sol:responses': 'normal',
      },
    });

    expect(options).toEqual({
      'openai/gpt-6-astra': 'priority',
      'openai/gpt-6-sol': 'default',
    });
    expect(options['openai/gpt-6-luna']).toBeUndefined();
  });

  it('merges exact OpenAI model tiers without replacing reasoning options', () => {
    expect(
      mergeOpenCodeModelFastModeOptions(
        {
          openai: {
            models: {
              'gpt-6-astra': { options: { reasoningEffort: 'high' } },
            },
          },
        },
        { 'openai/gpt-6-astra': 'default' },
      ),
    ).toEqual({
      openai: {
        models: {
          'gpt-6-astra': {
            options: { reasoningEffort: 'high', serviceTier: 'default' },
          },
        },
      },
    });
  });

  it('distinguishes a served Standard response from a confirmed Fast response', () => {
    const capabilityId = 'openai:openai-api-key:gpt-6-astra:responses';

    expect(
      validateModelFastModeResponse({
        capabilityId,
        requestedMode: 'fast',
        reportedTier: 'default',
      }),
    ).toBe('served-standard');
    expect(
      validateModelFastModeResponse({
        capabilityId,
        requestedMode: 'fast',
        reportedTier: 'priority',
      }),
    ).toBe('confirmed-fast');
    expect(
      validateModelFastModeResponse({
        capabilityId: 'openai:chatgpt-oauth:gpt-6-astra:responses',
        requestedMode: 'fast',
        reportedTier: 'priority',
      }),
    ).toBe('unreported');
  });
});
