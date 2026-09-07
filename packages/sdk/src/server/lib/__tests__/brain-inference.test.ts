import { describe, expect, it, vi } from 'vitest';

vi.mock('@roomote/db/server', () => ({
  resolveModelProviderEnvValue: vi.fn(),
}));

const mockEnv: {
  R_BRAIN_MODEL?: string;
  R_BRAIN_EMBEDDING_MODEL?: string;
  R_BRAIN_EMBEDDINGS_UPSTREAM_URL?: string;
} = {};

vi.mock('@roomote/env', () => ({ Env: mockEnv }));

const {
  mapBrainModelName,
  isBrainEmbeddingAvailable,
  resetBrainInferenceProviderCache,
} = await import('../brain-inference');
const { resolveModelProviderEnvValue } = await import('@roomote/db/server');
const mockResolveModelProviderEnvValue = vi.mocked(
  resolveModelProviderEnvValue,
);

const OPENROUTER = { providerId: 'openrouter', apiKey: 'sk-or' } as const;
const OPENAI = { providerId: 'openai', apiKey: 'sk' } as const;

beforeEach(() => {
  delete mockEnv.R_BRAIN_MODEL;
  delete mockEnv.R_BRAIN_EMBEDDING_MODEL;
  delete mockEnv.R_BRAIN_EMBEDDINGS_UPSTREAM_URL;
  mockResolveModelProviderEnvValue.mockReset();
  mockResolveModelProviderEnvValue.mockResolvedValue(undefined);
  resetBrainInferenceProviderCache();
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
});
