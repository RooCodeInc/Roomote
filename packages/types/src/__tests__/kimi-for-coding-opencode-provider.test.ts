import { describe, expect, it } from 'vitest';

import { mergeKimiForCodingProviderConfig } from '../kimi-for-coding-opencode-provider';

describe('mergeKimiForCodingProviderConfig', () => {
  it('leaves the config untouched when no selected model uses the provider', () => {
    const providerConfig = { anthropic: { options: { timeout: 1 } } };

    expect(
      mergeKimiForCodingProviderConfig(providerConfig, [
        'anthropic/claude-sonnet-5',
        undefined,
        // A different provider whose model merely mentions Kimi.
        'moonshotai/kimi-k3',
        'kimi-for-coding/',
      ]),
    ).toBe(providerConfig);
  });

  it('registers the full provider definition so OpenCode needs no catalog entry', () => {
    const merged = mergeKimiForCodingProviderConfig({}, ['kimi-for-coding/k3']);

    // Without `npm` and `api` OpenCode falls back to
    // `@ai-sdk/openai-compatible` with an empty base URL and every request
    // fails with `"undefined/chat/completions" cannot be parsed as a URL`.
    expect(merged['kimi-for-coding']).toMatchObject({
      npm: '@ai-sdk/anthropic',
      api: 'https://api.kimi.com/coding/v1',
      env: ['KIMI_API_KEY'],
      name: 'Kimi for Coding',
    });
  });

  it('registers every documented model, not only the selected one', () => {
    const merged = mergeKimiForCodingProviderConfig({}, ['kimi-for-coding/k3']);
    const models = (merged['kimi-for-coding'] as { models: object }).models;

    expect(Object.keys(models).sort()).toEqual([
      'k3',
      'k3-256k',
      'kimi-for-coding',
      'kimi-for-coding-highspeed',
    ]);
    expect(models).toMatchObject({
      k3: {
        name: 'Kimi K3',
        reasoning: true,
        tool_call: true,
        attachment: true,
        limit: { context: 1_048_576, output: 131_072 },
      },
      'kimi-for-coding': { limit: { context: 1_048_576, output: 32_768 } },
    });
  });

  it('gives a selected model Kimi added later a usable entry', () => {
    const merged = mergeKimiForCodingProviderConfig({}, [
      ' kimi-for-coding/k4-preview ',
    ]);

    expect(
      (merged['kimi-for-coding'] as { models: Record<string, unknown> }).models[
        'k4-preview'
      ],
    ).toEqual({ name: 'k4-preview' });
  });

  it('keeps existing provider and per-model config over the defaults', () => {
    const merged = mergeKimiForCodingProviderConfig(
      {
        other: { options: { keep: true } },
        'kimi-for-coding': {
          // e.g. an operator override, or the gateway rebase target.
          api: 'https://proxy.example/kimi/v1',
          options: { baseURL: 'https://gateway.example/kimi-for-coding/v1' },
          models: {
            k3: {
              name: 'Operator K3',
              options: { thinking: { type: 'enabled' } },
            },
          },
        },
      },
      ['kimi-for-coding/k3'],
    );

    expect(merged.other).toEqual({ options: { keep: true } });
    expect(merged['kimi-for-coding']).toMatchObject({
      npm: '@ai-sdk/anthropic',
      api: 'https://proxy.example/kimi/v1',
      options: { baseURL: 'https://gateway.example/kimi-for-coding/v1' },
      models: {
        k3: {
          name: 'Operator K3',
          options: { thinking: { type: 'enabled' } },
          // Defaults still fill what the existing entry left out.
          limit: { context: 1_048_576, output: 131_072 },
        },
      },
    });
  });
});
