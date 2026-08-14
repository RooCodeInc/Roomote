import { describe, expect, it } from 'vitest';

import { mergeOpenAiCompatibleProviderConfig } from '../opencode-provider-config';

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
