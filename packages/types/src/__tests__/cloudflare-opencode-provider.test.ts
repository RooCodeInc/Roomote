import { describe, expect, it } from 'vitest';

import { mergeCloudflareOpenCodeProviderConfig } from '../cloudflare-opencode-provider';

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
