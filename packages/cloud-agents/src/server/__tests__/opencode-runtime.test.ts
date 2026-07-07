import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildOpenCodeCliEnv } from '../opencode-runtime';

describe('buildOpenCodeCliEnv', () => {
  const managedKeys = [
    'OPENCODE_CONFIG_CONTENT',
    'ROOMOTE_MODEL',
    'ROOMOTE_SMALL_MODEL',
    'ROOMOTE_MODEL_REASONING_EFFORT',
    'ROOMOTE_SMALL_MODEL_REASONING_EFFORT',
    'GOOGLE_APPLICATION_CREDENTIALS',
  ] as const;
  const originalValues = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of managedKeys) {
      originalValues.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of managedKeys) {
      const original = originalValues.get(key);

      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  });

  it('builds a model-backed config without reasoning options by default', () => {
    const env = buildOpenCodeCliEnv({
      ROOMOTE_MODEL: 'openrouter/openai/gpt-5.4',
    });

    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
      model: 'openrouter/openai/gpt-5.4',
      small_model: 'openrouter/openai/gpt-5.4',
    });
  });

  it('applies per-role reasoning options to the model-backed config', () => {
    const env = buildOpenCodeCliEnv({
      ROOMOTE_MODEL: 'openrouter/openai/gpt-5.4',
      ROOMOTE_SMALL_MODEL: 'openrouter/z-ai/glm-5.2',
      ROOMOTE_MODEL_REASONING_EFFORT: 'high',
      ROOMOTE_SMALL_MODEL_REASONING_EFFORT: 'low',
    });

    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
      model: 'openrouter/openai/gpt-5.4',
      small_model: 'openrouter/z-ai/glm-5.2',
      provider: {
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
      },
    });
  });

  it('rewrites OpenRouter variant models to catalog base models with per-model options', () => {
    const env = buildOpenCodeCliEnv({
      ROOMOTE_MODEL: 'openrouter/z-ai/glm-5.2:nitro',
      ROOMOTE_MODEL_REASONING_EFFORT: 'high',
    });

    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
      model: 'openrouter/z-ai/glm-5.2',
      small_model: 'openrouter/z-ai/glm-5.2',
      provider: {
        openrouter: {
          models: {
            'z-ai/glm-5.2': {
              options: {
                reasoning: { effort: 'high' },
                provider: { sort: 'throughput' },
              },
            },
          },
        },
      },
    });
  });

  it('lets the coding model variant win when roles disagree on a shared base model', () => {
    const env = buildOpenCodeCliEnv({
      ROOMOTE_MODEL: 'openrouter/z-ai/glm-5.2:nitro',
      ROOMOTE_SMALL_MODEL: 'openrouter/z-ai/glm-5.2:free',
    });

    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
      model: 'openrouter/z-ai/glm-5.2',
      small_model: 'openrouter/z-ai/glm-5.2',
      provider: {
        openrouter: {
          models: {
            'z-ai/glm-5.2': { options: { provider: { sort: 'throughput' } } },
          },
        },
      },
    });
  });

  it('lets the coding model reasoning level win when both roles share a model', () => {
    const env = buildOpenCodeCliEnv({
      ROOMOTE_MODEL: 'openrouter/openai/gpt-5.4',
      ROOMOTE_SMALL_MODEL: 'openrouter/openai/gpt-5.4',
      ROOMOTE_MODEL_REASONING_EFFORT: 'high',
      ROOMOTE_SMALL_MODEL_REASONING_EFFORT: 'low',
    });

    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
      model: 'openrouter/openai/gpt-5.4',
      small_model: 'openrouter/openai/gpt-5.4',
      provider: {
        openrouter: {
          models: {
            'openai/gpt-5.4': {
              options: { reasoning: { effort: 'high' } },
            },
          },
        },
      },
    });
  });

  it('materializes inline GOOGLE_APPLICATION_CREDENTIALS JSON to a temp file path', () => {
    const credentialsJson = JSON.stringify({
      type: 'service_account',
      project_id: 'my-project',
    });

    const env = buildOpenCodeCliEnv({
      GOOGLE_APPLICATION_CREDENTIALS: credentialsJson,
    });

    const credentialsPath = env.GOOGLE_APPLICATION_CREDENTIALS;
    expect(credentialsPath).toBeDefined();
    expect(credentialsPath).not.toBe(credentialsJson);
    expect(readFileSync(credentialsPath!, 'utf8')).toBe(credentialsJson);
  });

  it('leaves a GOOGLE_APPLICATION_CREDENTIALS file path untouched', () => {
    const env = buildOpenCodeCliEnv({
      GOOGLE_APPLICATION_CREDENTIALS: '/etc/roomote/service-account.json',
    });

    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe(
      '/etc/roomote/service-account.json',
    );
  });
});
