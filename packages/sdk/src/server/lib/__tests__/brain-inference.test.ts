import { describe, expect, it, vi } from 'vitest';

vi.mock('@roomote/db/server', () => ({
  resolveModelProviderEnvValue: vi.fn(),
}));

const mockEnv: {
  R_BRAIN_MODEL?: string;
  R_BRAIN_EMBEDDING_MODEL?: string;
  R_BRAIN_EMBEDDING_DIMENSIONS?: number;
  R_BRAIN_EMBEDDINGS_UPSTREAM_URL?: string;
  R_BRAIN_INFERENCE_UPSTREAM_API_KEY?: string;
} = {};

vi.mock('@roomote/env', () => ({ Env: mockEnv }));

const {
  mapBrainModelName,
  describeBrainModels,
  isBrainEmbeddingAvailable,
  resolveBrainEmbeddingsUpstream,
  resetBrainEmbeddingsUpstreamCache,
  resetBrainInferenceProviderCache,
} = await import('../brain-inference');
const { resolveModelProviderEnvValue } = await import('@roomote/db/server');
const mockResolveModelProviderEnvValue = vi.mocked(
  resolveModelProviderEnvValue,
);

const OPENROUTER = { providerId: 'openrouter', apiKey: 'sk-or' } as const;
const OPENAI = { providerId: 'openai', apiKey: 'sk' } as const;
const CF_ACCOUNT_ID = 'a1b2c3d4e5f6789012345678abcdef90';

function envVarNames(names: string | readonly string[]): readonly string[] {
  return typeof names === 'string' ? [names] : names;
}

function mockCloudflareWorkersAi(): void {
  mockResolveModelProviderEnvValue.mockImplementation(async (names) => {
    const list = envVarNames(names);
    if (list.includes('CLOUDFLARE_WORKERS_AI_API_TOKEN')) {
      return 'cfat_test';
    }
    if (list.includes('CLOUDFLARE_WORKERS_AI_ACCOUNT_ID')) {
      return CF_ACCOUNT_ID;
    }
    return undefined;
  });
}

function mockCloudflareAndOpenRouter(): void {
  mockResolveModelProviderEnvValue.mockImplementation(async (names) => {
    const list = envVarNames(names);
    if (list.includes('CLOUDFLARE_WORKERS_AI_API_TOKEN')) {
      return 'cfat_test';
    }
    if (list.includes('CLOUDFLARE_WORKERS_AI_ACCOUNT_ID')) {
      return CF_ACCOUNT_ID;
    }
    if (
      list.includes('R_BRAIN_OPENROUTER_API_KEY') ||
      list.includes('OPENROUTER_API_KEY')
    ) {
      return 'sk-or';
    }
    return undefined;
  });
}

beforeEach(() => {
  delete mockEnv.R_BRAIN_MODEL;
  delete mockEnv.R_BRAIN_EMBEDDING_MODEL;
  delete mockEnv.R_BRAIN_EMBEDDING_DIMENSIONS;
  delete mockEnv.R_BRAIN_EMBEDDINGS_UPSTREAM_URL;
  delete mockEnv.R_BRAIN_INFERENCE_UPSTREAM_API_KEY;
  mockResolveModelProviderEnvValue.mockReset();
  mockResolveModelProviderEnvValue.mockResolvedValue(undefined);
  resetBrainInferenceProviderCache();
  resetBrainEmbeddingsUpstreamCache();
});

describe('mapBrainModelName', () => {
  it('translates model names between providers without changing the model', () => {
    expect(mapBrainModelName('text-embedding-3-small', OPENROUTER)).toBe(
      'openai/text-embedding-3-small',
    );
    expect(mapBrainModelName('openai/text-embedding-3-small', OPENAI)).toBe(
      'text-embedding-3-small',
    );
    expect(mapBrainModelName('gpt-5.6-luna', OPENROUTER)).toBe(
      'openai/gpt-5.6-luna',
    );
  });

  it('translates a non-default embedding model the Brain was built with', () => {
    expect(mapBrainModelName('text-embedding-3-large', OPENROUTER)).toBe(
      'openai/text-embedding-3-large',
    );
  });

  it('applies an operator override to the synthesis model', () => {
    mockEnv.R_BRAIN_MODEL = 'openai/gpt-5.6-mini';

    expect(mapBrainModelName('gpt-5.6-luna', OPENROUTER)).toBe(
      'openai/gpt-5.6-mini',
    );
  });

  it('never substitutes the embedding model at request time', () => {
    // The width of the Brain's vector column was fixed when it was created.
    // Swapping the embedding model per request would send vectors of a
    // different width into that column, so this setting is create-time only
    // and must not leak into a live request.
    mockEnv.R_BRAIN_EMBEDDING_MODEL = 'text-embedding-3-large';

    expect(mapBrainModelName('text-embedding-3-small', OPENROUTER)).toBe(
      'openai/text-embedding-3-small',
    );
    expect(mapBrainModelName('text-embedding-3-small', OPENAI)).toBe(
      'text-embedding-3-small',
    );
  });

  it('passes an unrecognized model through untouched', () => {
    expect(mapBrainModelName('some-custom-model', OPENROUTER)).toBe(
      'some-custom-model',
    );
  });
});

describe('isBrainEmbeddingAvailable', () => {
  it('is ready when a self-run embedder is configured, with no provider key', async () => {
    mockEnv.R_BRAIN_EMBEDDINGS_UPSTREAM_URL = 'https://embedder.example/v1';
    // No provider key of any kind — the trial/Anthropic-only case.
    await expect(isBrainEmbeddingAvailable()).resolves.toBe(true);
    expect(mockResolveModelProviderEnvValue).not.toHaveBeenCalled();
  });

  it('falls back to an embeddings-capable provider key when no embedder is set', async () => {
    mockResolveModelProviderEnvValue.mockResolvedValue('sk-or');
    await expect(isBrainEmbeddingAvailable()).resolves.toBe(true);
  });

  it('is not ready with neither an embedder nor a provider key', async () => {
    await expect(isBrainEmbeddingAvailable()).resolves.toBe(false);
  });

  it('treats a whitespace-only upstream as unset', async () => {
    mockEnv.R_BRAIN_EMBEDDINGS_UPSTREAM_URL = '   ';
    await expect(isBrainEmbeddingAvailable()).resolves.toBe(false);
  });

  it('is ready when Cloudflare Workers AI can embed, with no OpenAI key', async () => {
    mockCloudflareWorkersAi();
    await expect(isBrainEmbeddingAvailable()).resolves.toBe(true);
  });

  it('is not ready with a Cloudflare token and no account id', async () => {
    mockResolveModelProviderEnvValue.mockImplementation(async (names) => {
      const list = envVarNames(names);
      if (list.includes('CLOUDFLARE_WORKERS_AI_API_TOKEN')) {
        return 'cfat_test';
      }
      return undefined;
    });
    await expect(isBrainEmbeddingAvailable()).resolves.toBe(false);
  });

  it('is not ready with a Cloudflare account id and no token', async () => {
    mockResolveModelProviderEnvValue.mockImplementation(async (names) => {
      const list = envVarNames(names);
      if (list.includes('CLOUDFLARE_WORKERS_AI_ACCOUNT_ID')) {
        return CF_ACCOUNT_ID;
      }
      return undefined;
    });
    await expect(isBrainEmbeddingAvailable()).resolves.toBe(false);
  });

  it('is not ready with an account id that is not 32 hex characters', async () => {
    mockResolveModelProviderEnvValue.mockImplementation(async (names) => {
      const list = envVarNames(names);
      if (list.includes('CLOUDFLARE_WORKERS_AI_API_TOKEN')) {
        return 'cfat_test';
      }
      if (list.includes('CLOUDFLARE_WORKERS_AI_ACCOUNT_ID')) {
        return 'not-a-cloudflare-account-id';
      }
      return undefined;
    });
    await expect(isBrainEmbeddingAvailable()).resolves.toBe(false);
  });

  it('is not ready with a 32-character account id that is not hex', async () => {
    mockResolveModelProviderEnvValue.mockImplementation(async (names) => {
      const list = envVarNames(names);
      if (list.includes('CLOUDFLARE_WORKERS_AI_API_TOKEN')) {
        return 'cfat_test';
      }
      if (list.includes('CLOUDFLARE_WORKERS_AI_ACCOUNT_ID')) {
        return 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
      }
      return undefined;
    });
    await expect(isBrainEmbeddingAvailable()).resolves.toBe(false);
  });
});

describe('resolveBrainEmbeddingsUpstream', () => {
  it('returns the configured URL and key, without reading Cloudflare', async () => {
    mockEnv.R_BRAIN_EMBEDDINGS_UPSTREAM_URL = 'https://embedder.example/v1/';
    mockEnv.R_BRAIN_INFERENCE_UPSTREAM_API_KEY = 'local-key';
    mockCloudflareWorkersAi();

    await expect(resolveBrainEmbeddingsUpstream()).resolves.toEqual({
      baseUrl: 'https://embedder.example/v1',
      apiKey: 'local-key',
      source: 'configured',
    });
    expect(mockResolveModelProviderEnvValue).not.toHaveBeenCalled();
  });

  it('wires Cloudflare Workers AI as an OpenAI-compatible /ai base', async () => {
    mockCloudflareWorkersAi();

    await expect(resolveBrainEmbeddingsUpstream()).resolves.toEqual({
      baseUrl: `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai`,
      apiKey: 'cfat_test',
      source: 'cloudflare-workers-ai',
    });
  });

  it('does not auto-wire Cloudflare when an OpenAI or OpenRouter key already serves embeddings', async () => {
    mockCloudflareAndOpenRouter();

    await expect(resolveBrainEmbeddingsUpstream()).resolves.toBeNull();
    await expect(
      resolveBrainEmbeddingsUpstream('text-embedding-3-small'),
    ).resolves.toBeNull();
    await expect(isBrainEmbeddingAvailable()).resolves.toBe(true);
  });

  it('keeps Cloudflare-model corpora on Cloudflare when a provider key is added', async () => {
    mockCloudflareAndOpenRouter();

    await expect(resolveBrainEmbeddingsUpstream()).resolves.toBeNull();
    await expect(
      resolveBrainEmbeddingsUpstream('@cf/baai/bge-m3'),
    ).resolves.toEqual({
      baseUrl: `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai`,
      apiKey: 'cfat_test',
      source: 'cloudflare-workers-ai',
    });
  });

  it('caches a Cloudflare miss so an unconfigured tick does not re-read settings', async () => {
    await expect(resolveBrainEmbeddingsUpstream()).resolves.toBeNull();
    const afterFirst = mockResolveModelProviderEnvValue.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);
    await expect(resolveBrainEmbeddingsUpstream()).resolves.toBeNull();
    expect(mockResolveModelProviderEnvValue).toHaveBeenCalledTimes(afterFirst);
  });

  it('caches a Cloudflare hit across embeddings requests', async () => {
    mockCloudflareWorkersAi();
    await resolveBrainEmbeddingsUpstream();
    const afterFirst = mockResolveModelProviderEnvValue.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);
    await resolveBrainEmbeddingsUpstream();
    expect(mockResolveModelProviderEnvValue).toHaveBeenCalledTimes(afterFirst);
  });
});

describe('describeBrainModels', () => {
  it('reports 1024 dimensions for bge-m3', () => {
    mockEnv.R_BRAIN_EMBEDDING_MODEL = '@cf/baai/bge-m3';

    expect(describeBrainModels('openai')).toMatchObject({
      embeddingModel: '@cf/baai/bge-m3',
      embeddingDimensions: 1024,
    });
  });
});
