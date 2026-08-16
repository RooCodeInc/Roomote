import { describe, expect, it } from 'vitest';

import {
  mergeCloudflareOpenCodeProviderConfig,
  mergeOpenAiCompatibleProviderConfig,
} from '../opencode-provider-config';

describe('mergeOpenAiCompatibleProviderConfig', () => {
  it('materializes LiteLLM provider metadata for selected models', () => {
    expect(
      mergeOpenAiCompatibleProviderConfig(
        {},
        {
          LITELLM_BASE_URL: 'https://litellm.example.com/v1',
          LITELLM_API_KEY: 'secret',
        },
        ['litellm/qwen3.6:35b-unsloth', 'litellm/coding'],
      ),
    ).toEqual({
      litellm: {
        npm: '@ai-sdk/openai-compatible',
        name: 'LiteLLM',
        options: {
          baseURL: 'https://litellm.example.com/v1',
          apiKey: '{env:LITELLM_API_KEY}',
        },
        models: {
          'qwen3.6:35b-unsloth': { name: 'qwen3.6:35b-unsloth' },
          coding: { name: 'coding' },
        },
      },
    });
  });

  it('applies trusted context windows while preserving existing model options', () => {
    const config = mergeOpenAiCompatibleProviderConfig(
      {
        litellm: {
          models: {
            'qwen3.6:35b-unsloth': {
              options: { temperature: 0 },
              limit: { context: 999_999, output: 16_000 },
            },
          },
        },
      },
      {
        LITELLM_BASE_URL: 'https://litellm.example.com/v1',
        LITELLM_API_KEY: 'secret',
      },
      ['litellm/qwen3.6:35b-unsloth', 'litellm/unknown'],
      undefined,
      { 'litellm/qwen3.6:35b-unsloth': 210_176 },
    );

    expect(config).toMatchObject({
      litellm: {
        models: {
          'qwen3.6:35b-unsloth': {
            options: { temperature: 0 },
            limit: {
              context: 210_176,
              output: 16_000,
            },
          },
          unknown: { name: 'unknown' },
        },
      },
    });
    expect(config).not.toHaveProperty([
      'litellm',
      'models',
      'qwen3.6:35b-unsloth',
      'limit',
      'input',
    ]);
  });

  it('preserves independently configured input limits', () => {
    const config = mergeOpenAiCompatibleProviderConfig(
      {
        litellm: {
          models: {
            coding: { limit: { input: 120_000, output: 8_000 } },
          },
        },
      },
      {},
      ['litellm/coding'],
      undefined,
      { 'litellm/coding': 128_000 },
    );

    expect(config).toHaveProperty(
      ['litellm', 'models', 'coding', 'limit', 'input'],
      120_000,
    );
  });

  it('preserves existing model options for named OpenAI-compatible providers', () => {
    expect(
      mergeOpenAiCompatibleProviderConfig(
        {
          'openai-compatible-company-proxy': {
            models: { 'gpt-4o': { options: { temperature: 0 } } },
          },
        },
        {
          OPENAI_COMPATIBLE_COMPANY_PROXY_BASE_URL:
            'https://proxy.example.com/v1',
          OPENAI_COMPATIBLE_COMPANY_PROXY_API_KEY: 'secret',
          OPENAI_COMPATIBLE_COMPANY_PROXY_LABEL: 'Corp Proxy',
        },
        ['openai-compatible-company-proxy/gpt-4o'],
      ),
    ).toMatchObject({
      'openai-compatible-company-proxy': {
        npm: '@ai-sdk/openai-compatible',
        name: 'OpenAI-compatible (Corp Proxy)',
        options: {
          baseURL: 'https://proxy.example.com/v1',
          apiKey: '{env:OPENAI_COMPATIBLE_COMPANY_PROXY_API_KEY}',
        },
        models: {
          'gpt-4o': { name: 'gpt-4o', options: { temperature: 0 } },
        },
      },
    });
  });

  it('marks the configured vision model as image and video capable', () => {
    expect(
      mergeOpenAiCompatibleProviderConfig(
        {},
        {
          LITELLM_BASE_URL: 'https://litellm.example.com/v1',
          LITELLM_API_KEY: 'secret',
        },
        ['litellm/text-model', 'litellm/vision-model'],
        'litellm/vision-model',
      ),
    ).toMatchObject({
      litellm: {
        models: {
          'text-model': { name: 'text-model' },
          'vision-model': {
            name: 'vision-model',
            attachment: true,
            modalities: {
              input: ['text', 'image', 'video'],
              output: ['text'],
            },
          },
        },
      },
    });
  });
});

describe('mergeCloudflareOpenCodeProviderConfig', () => {
  it('materializes AI Gateway with Roomote env names and a gateway header', () => {
    expect(
      mergeCloudflareOpenCodeProviderConfig(
        {},
        {
          CLOUDFLARE_AI_GATEWAY_API_TOKEN: 'token',
          CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID: 'a1b2c3d4e5f6789012345678abcdef90',
          CLOUDFLARE_AI_GATEWAY_ID: 'my_gateway',
        },
        ['cloudflare-ai-gateway/openai/gpt-5.6-terra'],
      ),
    ).toEqual({
      'cloudflare-ai-gateway': {
        npm: '@ai-sdk/openai-compatible',
        name: 'Cloudflare AI Gateway',
        options: {
          baseURL:
            'https://api.cloudflare.com/client/v4/accounts/a1b2c3d4e5f6789012345678abcdef90/ai/v1',
          apiKey: '{env:CLOUDFLARE_AI_GATEWAY_API_TOKEN}',
          headers: { 'cf-aig-gateway-id': 'my_gateway' },
        },
        models: {
          'openai/gpt-5.6-terra': { name: 'openai/gpt-5.6-terra' },
        },
      },
    });
  });

  it('rewrites workers-ai/@cf models to @cf for the /ai/v1 surface', () => {
    const merged = mergeCloudflareOpenCodeProviderConfig(
      {},
      {
        CLOUDFLARE_AI_GATEWAY_API_TOKEN: 'token',
        CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID: 'a1b2c3d4e5f6789012345678abcdef90',
        CLOUDFLARE_AI_GATEWAY_ID: 'default',
      },
      ['cloudflare-ai-gateway/workers-ai/@cf/zai-org/glm-5.2'],
    );

    expect(
      merged['cloudflare-ai-gateway'] as { models?: Record<string, unknown> },
    ).toMatchObject({
      models: {
        '@cf/zai-org/glm-5.2': { name: '@cf/zai-org/glm-5.2' },
      },
    });
    expect(
      (merged['cloudflare-ai-gateway'] as { models?: Record<string, unknown> })
        .models,
    ).not.toHaveProperty('workers-ai/@cf/zai-org/glm-5.2');
  });

  it('does not treat a complete AI Gateway config as Workers AI config', () => {
    const workersAi = mergeCloudflareOpenCodeProviderConfig(
      {},
      {
        CLOUDFLARE_AI_GATEWAY_API_TOKEN: 'token',
        CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID: 'a1b2c3d4e5f6789012345678abcdef90',
        CLOUDFLARE_AI_GATEWAY_ID: 'default',
      },
      [
        'cloudflare-ai-gateway/openai/gpt-5.6-terra',
        'cloudflare-workers-ai/@cf/moonshotai/kimi-k2.7-code',
      ],
    )['cloudflare-workers-ai'] as
      | { options?: Record<string, unknown> }
      | undefined;

    expect(workersAi?.options?.apiKey).toBeUndefined();
    expect(workersAi?.options?.baseURL).toBeUndefined();
  });

  it('registers rewritten AI Gateway models when the token is withheld', () => {
    const merged = mergeCloudflareOpenCodeProviderConfig(
      {},
      {
        CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID: 'a1b2c3d4e5f6789012345678abcdef90',
        CLOUDFLARE_AI_GATEWAY_ID: 'default',
      },
      ['cloudflare-ai-gateway/workers-ai/@cf/zai-org/glm-5.2'],
    );

    expect(merged['cloudflare-ai-gateway']).toMatchObject({
      npm: '@ai-sdk/openai-compatible',
      models: {
        '@cf/zai-org/glm-5.2': { name: '@cf/zai-org/glm-5.2' },
      },
    });
    expect(
      (merged['cloudflare-ai-gateway'] as { options?: Record<string, unknown> })
        .options?.baseURL,
    ).toBeUndefined();
    expect(
      (merged['cloudflare-ai-gateway'] as { options?: Record<string, unknown> })
        .options?.apiKey,
    ).toBeUndefined();
  });

  it('materializes Workers AI without a gateway header', () => {
    expect(
      mergeCloudflareOpenCodeProviderConfig(
        {},
        {
          CLOUDFLARE_WORKERS_AI_API_TOKEN: 'token',
          CLOUDFLARE_WORKERS_AI_ACCOUNT_ID: 'a1b2c3d4e5f6789012345678abcdef90',
        },
        ['cloudflare-workers-ai/@cf/moonshotai/kimi-k2.7-code'],
      ),
    ).toEqual({
      'cloudflare-workers-ai': {
        npm: '@ai-sdk/openai-compatible',
        name: 'Cloudflare Workers AI',
        options: {
          baseURL:
            'https://api.cloudflare.com/client/v4/accounts/a1b2c3d4e5f6789012345678abcdef90/ai/v1',
          apiKey: '{env:CLOUDFLARE_WORKERS_AI_API_TOKEN}',
        },
        models: {
          '@cf/moonshotai/kimi-k2.7-code': {
            name: '@cf/moonshotai/kimi-k2.7-code',
          },
        },
      },
    });
  });
});
