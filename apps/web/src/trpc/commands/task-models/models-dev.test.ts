import { describe, expect, it } from 'vitest';

import {
  fetchModelsDevCatalog,
  lookupModelMetadataFromCatalog,
  resolveModelsDevSlug,
  suggestModelsFromCatalog,
  type ModelsDevCatalog,
} from './models-dev';

function buildCatalog(
  overrides: Partial<ModelsDevCatalog> = {},
): ModelsDevCatalog {
  return {
    models: {},
    providers: {},
    gatewayModelsByLowerSlug: {},
    ...overrides,
  };
}

describe('resolveModelsDevSlug', () => {
  it('strips the openrouter/ prefix and ~ alias marker', () => {
    expect(resolveModelsDevSlug('openrouter/z-ai/glm-5.2')).toBe(
      'z-ai/glm-5.2',
    );
    expect(
      resolveModelsDevSlug('openrouter/~anthropic/claude-sonnet-latest'),
    ).toBe('anthropic/claude-sonnet-latest');
    expect(resolveModelsDevSlug('anthropic/claude-opus-4.7')).toBe(
      'anthropic/claude-opus-4.7',
    );
  });

  it('strips the vercel/ prefix for AI Gateway routed models', () => {
    expect(resolveModelsDevSlug('vercel/openai/gpt-5.4')).toBe(
      'openai/gpt-5.4',
    );
    expect(resolveModelsDevSlug('vercel/~anthropic/claude-sonnet-latest')).toBe(
      'anthropic/claude-sonnet-latest',
    );
  });

  it('strips the requesty/ prefix for Requesty routed models', () => {
    expect(resolveModelsDevSlug('requesty/gpt-5.6-terra@eu')).toBe(
      'gpt-5.6-terra@eu',
    );
    expect(resolveModelsDevSlug('requesty/~claude-sonnet-5')).toBe(
      'claude-sonnet-5',
    );
  });

  it('strips the baseten/ prefix for Baseten routed models', () => {
    expect(resolveModelsDevSlug('baseten/moonshotai/Kimi-K2.7-Code')).toBe(
      'moonshotai/Kimi-K2.7-Code',
    );
    expect(resolveModelsDevSlug('baseten/zai-org/GLM-5.2')).toBe(
      'zai-org/GLM-5.2',
    );
  });

  it('strips the togetherai/ prefix for Together AI routed models', () => {
    expect(resolveModelsDevSlug('togetherai/deepseek-ai/DeepSeek-V4-Pro')).toBe(
      'deepseek-ai/DeepSeek-V4-Pro',
    );
    expect(resolveModelsDevSlug('togetherai/zai-org/GLM-5.2')).toBe(
      'zai-org/GLM-5.2',
    );
  });

  it('strips the cloudflare-ai-gateway/ prefix for AI Gateway routed models', () => {
    expect(
      resolveModelsDevSlug('cloudflare-ai-gateway/openai/gpt-5.6-terra'),
    ).toBe('openai/gpt-5.6-terra');
    expect(
      resolveModelsDevSlug(
        'cloudflare-ai-gateway/workers-ai/@cf/zai-org/glm-5.2',
      ),
    ).toBe('workers-ai/@cf/zai-org/glm-5.2');
  });

  it('strips the cloudflare-workers-ai/ prefix for hosted Workers AI models', () => {
    expect(
      resolveModelsDevSlug(
        'cloudflare-workers-ai/@cf/moonshotai/kimi-k2.7-code',
      ),
    ).toBe('@cf/moonshotai/kimi-k2.7-code');
  });

  it('maps Bedrock Mantle model ids to their models.dev lab slugs', () => {
    expect(
      resolveModelsDevSlug('bedrock-mantle/anthropic.claude-haiku-4-5'),
    ).toBe('anthropic/claude-haiku-4-5');
  });
});

describe('lookupModelMetadataFromCatalog', () => {
  it('returns openrouter pricing/context/modalities for an openrouter-routed model (case-insensitive)', () => {
    const catalog = buildCatalog({
      gatewayModelsByLowerSlug: {
        openrouter: {
          'z-ai/glm-5.2': {
            id: 'z-ai/glm-5.2',
            name: 'GLM 5.2',
            modalities: { input: ['text'] },
            limit: { context: 1048576, output: 32768 },
            cost: { input: 0.93, output: 3 },
          },
        },
      },
    });

    const result = lookupModelMetadataFromCatalog(
      catalog,
      'openrouter/z-ai/glm-5.2',
    );

    expect(result.metadata).toEqual({
      contextWindow: 1048576,
      inputTypes: ['text'],
      inputPricePerToken: 0.93 / 1_000_000,
      outputPricePerToken: 3 / 1_000_000,
    });
    expect(result.displayName).toBe('GLM 5.2');
  });

  it('matches case-insensitively for mixed-case slugs', () => {
    const catalog = buildCatalog({
      gatewayModelsByLowerSlug: {
        openrouter: {
          'minimax/minimax-m3': {
            name: 'MiniMax M3',
            limit: { context: 512000 },
            cost: { input: 0, output: 0 },
            modalities: { input: ['text', 'image', 'pdf'] },
          },
        },
      },
    });

    const result = lookupModelMetadataFromCatalog(
      catalog,
      'openrouter/minimax/MiniMax-M3',
    );

    expect(result.metadata.contextWindow).toBe(512000);
    expect(result.metadata.inputTypes).toEqual(['text', 'image', 'pdf']);
    expect(result.displayName).toBe('MiniMax M3');
  });

  it('maps audio modality to sound and file to pdf', () => {
    const catalog = buildCatalog({
      gatewayModelsByLowerSlug: {
        openrouter: {
          'some/multimodal': {
            modalities: {
              input: ['text', 'audio', 'file', 'video', 'image'],
            },
            limit: { context: 128000 },
          },
        },
      },
    });

    const result = lookupModelMetadataFromCatalog(
      catalog,
      'openrouter/some/multimodal',
    );

    expect(result.metadata.inputTypes).toEqual([
      'text',
      'image',
      'video',
      'sound',
      'pdf',
    ]);
  });

  it('returns empty metadata when the model is not in the catalog', () => {
    const catalog = buildCatalog();
    const result = lookupModelMetadataFromCatalog(
      catalog,
      'openrouter/unknown/model',
    );
    expect(result.metadata).toEqual({});
    expect(result.displayName).toBeUndefined();
  });

  it('falls back to provider-agnostic models + lab provider pricing for non-openrouter models', () => {
    const catalog = buildCatalog({
      models: {
        'anthropic/claude-opus-4-7': {
          name: 'Claude Opus 4.7',
          modalities: { input: ['text', 'image', 'pdf'] },
          limit: { context: 200000 },
        },
      },
      providers: {
        anthropic: {
          models: {
            'anthropic/claude-opus-4-7': {
              cost: { input: 5, output: 25 },
            },
          },
        },
      },
    });

    const result = lookupModelMetadataFromCatalog(
      catalog,
      'anthropic/claude-opus-4-7',
    );

    expect(result.metadata.contextWindow).toBe(200000);
    expect(result.metadata.inputTypes).toEqual(['text', 'image', 'pdf']);
    expect(result.metadata.inputPricePerToken).toBe(5 / 1_000_000);
    expect(result.metadata.outputPricePerToken).toBe(25 / 1_000_000);
    expect(result.displayName).toBe('Claude Opus 4.7');
  });

  it('resolves Bedrock Mantle metadata through the underlying model lab', () => {
    const catalog = buildCatalog({
      models: {
        'anthropic/claude-sonnet-5': {
          name: 'Claude Sonnet 5',
          modalities: { input: ['text', 'image', 'pdf'] },
          limit: { context: 200000 },
        },
      },
      providers: {
        anthropic: {
          models: {
            'anthropic/claude-sonnet-5': {
              cost: { input: 3, output: 15 },
            },
          },
        },
      },
    });

    const result = lookupModelMetadataFromCatalog(
      catalog,
      'bedrock-mantle/anthropic.claude-sonnet-5',
    );

    expect(result.metadata).toEqual({
      contextWindow: 200000,
      inputTypes: ['text', 'image', 'pdf'],
      inputPricePerToken: 3 / 1_000_000,
      outputPricePerToken: 15 / 1_000_000,
    });
    expect(result.displayName).toBe('Claude Sonnet 5');
  });

  it('resolves native Bedrock metadata from its provider catalog', () => {
    const catalog = buildCatalog({
      providers: {
        'amazon-bedrock': {
          models: {
            'eu.anthropic.claude-sonnet-5': {
              name: 'Claude Sonnet 5 (EU)',
              modalities: { input: ['text', 'image'] },
              limit: { context: 200000 },
              cost: { input: 3, output: 15 },
            },
          },
        },
      },
    });

    const result = lookupModelMetadataFromCatalog(
      catalog,
      'amazon-bedrock/eu.anthropic.claude-sonnet-5',
    );

    expect(result.displayName).toBe('Claude Sonnet 5 (EU)');
    expect(result.metadata).toEqual({
      contextWindow: 200000,
      inputTypes: ['text', 'image'],
      inputPricePerToken: 3 / 1_000_000,
      outputPricePerToken: 15 / 1_000_000,
    });
  });

  it('prefers the vercel gateway entry for vercel-routed models', () => {
    const catalog = buildCatalog({
      gatewayModelsByLowerSlug: {
        vercel: {
          'openai/gpt-5.4': {
            id: 'openai/gpt-5.4',
            name: 'GPT 5.4',
            modalities: { input: ['text', 'image'] },
            limit: { context: 400000 },
            cost: { input: 1.25, output: 10 },
          },
        },
      },
    });

    const result = lookupModelMetadataFromCatalog(
      catalog,
      'vercel/openai/gpt-5.4',
    );

    expect(result.metadata).toEqual({
      contextWindow: 400000,
      inputTypes: ['text', 'image'],
      inputPricePerToken: 1.25 / 1_000_000,
      outputPricePerToken: 10 / 1_000_000,
    });
    expect(result.displayName).toBe('GPT 5.4');
  });

  it('falls back to the provider-agnostic models map for vercel-routed models missing from the gateway entry', () => {
    const catalog = buildCatalog({
      models: {
        'openai/gpt-5.4': {
          name: 'GPT 5.4',
          modalities: { input: ['text', 'image'] },
          limit: { context: 400000 },
        },
      },
    });

    const result = lookupModelMetadataFromCatalog(
      catalog,
      'vercel/openai/gpt-5.4',
    );

    expect(result.metadata.contextWindow).toBe(400000);
    expect(result.metadata.inputTypes).toEqual(['text', 'image']);
    expect(result.displayName).toBe('GPT 5.4');
  });

  it('prefers the requesty gateway entry for requesty-routed models', () => {
    const catalog = buildCatalog({
      gatewayModelsByLowerSlug: {
        requesty: {
          'claude-sonnet-5': {
            id: 'claude-sonnet-5',
            name: 'Claude Sonnet 5',
            modalities: { input: ['text', 'image', 'pdf'] },
            limit: { context: 1000000 },
            cost: { input: 2, output: 10 },
          },
        },
      },
    });

    const result = lookupModelMetadataFromCatalog(
      catalog,
      'requesty/claude-sonnet-5',
    );

    expect(result.metadata).toEqual({
      contextWindow: 1000000,
      inputTypes: ['text', 'image', 'pdf'],
      inputPricePerToken: 2 / 1_000_000,
      outputPricePerToken: 10 / 1_000_000,
    });
    expect(result.displayName).toBe('Claude Sonnet 5');
  });

  it('falls back to the provider-agnostic models map for requesty-routed models missing from the gateway entry', () => {
    const catalog = buildCatalog({
      models: {
        'openai/gpt-5.4': {
          name: 'GPT 5.4',
          modalities: { input: ['text', 'image'] },
          limit: { context: 400000 },
        },
      },
    });

    const result = lookupModelMetadataFromCatalog(
      catalog,
      'requesty/openai/gpt-5.4',
    );

    expect(result.metadata.contextWindow).toBe(400000);
    expect(result.metadata.inputTypes).toEqual(['text', 'image']);
    expect(result.displayName).toBe('GPT 5.4');
  });

  it('prefers the baseten gateway entry for baseten-routed models', () => {
    const catalog = buildCatalog({
      gatewayModelsByLowerSlug: {
        baseten: {
          'moonshotai/kimi-k2.7-code': {
            id: 'moonshotai/Kimi-K2.7-Code',
            name: 'Kimi K2.7 Code',
            modalities: { input: ['text', 'image'] },
            limit: { context: 262000 },
            cost: { input: 0.95, output: 4 },
          },
        },
      },
    });

    const result = lookupModelMetadataFromCatalog(
      catalog,
      'baseten/moonshotai/Kimi-K2.7-Code',
    );

    expect(result.metadata).toEqual({
      contextWindow: 262000,
      inputTypes: ['text', 'image'],
      inputPricePerToken: 0.95 / 1_000_000,
      outputPricePerToken: 4 / 1_000_000,
    });
    expect(result.displayName).toBe('Kimi K2.7 Code');
  });
});

describe('fetchModelsDevCatalog', () => {
  it('returns null when the fetch is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await fetchModelsDevCatalog(controller.signal);
    expect(result).toBeNull();
  });
});

describe('suggestModelsFromCatalog', () => {
  it('finds model names with a fuzzy query', () => {
    const catalog = buildCatalog({
      providers: {
        openrouter: {
          models: {
            'moonshotai/kimi-k3': { name: 'Kimi K3' },
          },
        },
      },
    });

    expect(
      suggestModelsFromCatalog({
        catalog,
        providerId: 'openrouter',
        query: 'km3',
      }),
    ).toEqual([{ slug: 'moonshotai/kimi-k3', displayName: 'Kimi K3' }]);
  });
});
