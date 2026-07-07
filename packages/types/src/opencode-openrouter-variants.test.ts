import {
  collectOpenRouterVariantModelAlias,
  mergeOpenRouterVariantAliasModels,
  resolveOpenRouterVariantModelAlias,
  type OpenRouterVariantModelAlias,
} from './opencode-openrouter-variants';

describe('resolveOpenRouterVariantModelAlias', () => {
  it('resolves a routing variant to a base-model rewrite with request options', () => {
    expect(
      resolveOpenRouterVariantModelAlias('openrouter/z-ai/glm-5.2:nitro'),
    ).toEqual({
      baseModel: 'openrouter/z-ai/glm-5.2',
      baseModelID: 'z-ai/glm-5.2',
      variantModelID: 'z-ai/glm-5.2:nitro',
      routingOptions: { provider: { sort: 'throughput' } },
    });
    expect(
      resolveOpenRouterVariantModelAlias('openrouter/z-ai/glm-5.2:floor')
        ?.routingOptions,
    ).toEqual({ provider: { sort: 'price' } });
  });

  it('resolves an endpoint variant to a wire-ID alias without routing options', () => {
    expect(
      resolveOpenRouterVariantModelAlias('openrouter/z-ai/glm-5.2:free'),
    ).toEqual({
      baseModel: 'openrouter/z-ai/glm-5.2',
      baseModelID: 'z-ai/glm-5.2',
      variantModelID: 'z-ai/glm-5.2:free',
    });
  });

  it('returns null for OpenRouter models without a variant suffix', () => {
    expect(
      resolveOpenRouterVariantModelAlias('openrouter/z-ai/glm-5.2'),
    ).toBeNull();
  });

  it('returns null for non-OpenRouter models even when the ID contains a colon', () => {
    expect(resolveOpenRouterVariantModelAlias('ollama/llama3:8b')).toBeNull();
  });

  it('returns null for model IDs that cannot be parsed', () => {
    expect(resolveOpenRouterVariantModelAlias('not-a-model')).toBeNull();
  });
});

describe('collectOpenRouterVariantModelAlias', () => {
  it('rewrites a variant model to its base model and records the alias', () => {
    const aliases = new Map<string, OpenRouterVariantModelAlias>();

    expect(
      collectOpenRouterVariantModelAlias(
        aliases,
        'openrouter/z-ai/glm-5.2:nitro',
      ),
    ).toBe('openrouter/z-ai/glm-5.2');
    expect(aliases.get('z-ai/glm-5.2')?.variantModelID).toBe(
      'z-ai/glm-5.2:nitro',
    );
  });

  it('passes non-variant models through without recording an alias', () => {
    const aliases = new Map<string, OpenRouterVariantModelAlias>();

    expect(
      collectOpenRouterVariantModelAlias(aliases, 'anthropic/claude-sonnet-5'),
    ).toBe('anthropic/claude-sonnet-5');
    expect(aliases.size).toBe(0);
  });

  it('accepts the same variant of a base model across roles', () => {
    const aliases = new Map<string, OpenRouterVariantModelAlias>();

    collectOpenRouterVariantModelAlias(
      aliases,
      'openrouter/z-ai/glm-5.2:nitro',
    );
    collectOpenRouterVariantModelAlias(
      aliases,
      'openrouter/z-ai/glm-5.2:nitro',
    );

    expect(aliases.size).toBe(1);
  });

  it('keeps the first collected variant when roles disagree on a shared base model', () => {
    const aliases = new Map<string, OpenRouterVariantModelAlias>();

    collectOpenRouterVariantModelAlias(
      aliases,
      'openrouter/z-ai/glm-5.2:nitro',
    );

    expect(
      collectOpenRouterVariantModelAlias(
        aliases,
        'openrouter/z-ai/glm-5.2:free',
      ),
    ).toBe('openrouter/z-ai/glm-5.2');
    expect(aliases.get('z-ai/glm-5.2')?.variantModelID).toBe(
      'z-ai/glm-5.2:nitro',
    );
  });
});

describe('mergeOpenRouterVariantAliasModels', () => {
  it('returns the provider config untouched when no aliases were collected', () => {
    const providerConfig = { openrouter: { models: {} } };

    expect(mergeOpenRouterVariantAliasModels(providerConfig, new Map())).toBe(
      providerConfig,
    );
  });

  it('emits per-model request options for routing variants', () => {
    const aliases = new Map<string, OpenRouterVariantModelAlias>();

    collectOpenRouterVariantModelAlias(
      aliases,
      'openrouter/z-ai/glm-5.2:nitro',
    );

    expect(mergeOpenRouterVariantAliasModels({}, aliases)).toEqual({
      openrouter: {
        models: {
          'z-ai/glm-5.2': {
            options: { provider: { sort: 'throughput' } },
          },
        },
      },
    });
  });

  it('emits a wire-ID override for endpoint variants', () => {
    const aliases = new Map<string, OpenRouterVariantModelAlias>();

    collectOpenRouterVariantModelAlias(aliases, 'openrouter/z-ai/glm-5.2:free');

    expect(mergeOpenRouterVariantAliasModels({}, aliases)).toEqual({
      openrouter: {
        models: {
          'z-ai/glm-5.2': { id: 'z-ai/glm-5.2:free' },
        },
      },
    });
  });

  it('preserves existing per-model entries such as reasoning options', () => {
    const aliases = new Map<string, OpenRouterVariantModelAlias>();

    collectOpenRouterVariantModelAlias(
      aliases,
      'openrouter/z-ai/glm-5.2:nitro',
    );
    collectOpenRouterVariantModelAlias(
      aliases,
      'openrouter/moonshotai/kimi-k2.6:free',
    );

    expect(
      mergeOpenRouterVariantAliasModels(
        {
          openrouter: {
            options: { headers: { 'X-Title': 'Roomote' } },
            models: {
              'z-ai/glm-5.2': {
                options: { reasoning: { effort: 'high' } },
              },
              'moonshotai/kimi-k2.6': {
                options: { reasoning: { effort: 'low' } },
              },
            },
          },
        },
        aliases,
      ),
    ).toEqual({
      openrouter: {
        options: { headers: { 'X-Title': 'Roomote' } },
        models: {
          'z-ai/glm-5.2': {
            options: {
              reasoning: { effort: 'high' },
              provider: { sort: 'throughput' },
            },
          },
          'moonshotai/kimi-k2.6': {
            options: { reasoning: { effort: 'low' } },
            id: 'moonshotai/kimi-k2.6:free',
          },
        },
      },
    });
  });
});
