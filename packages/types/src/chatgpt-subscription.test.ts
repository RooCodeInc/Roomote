import { describe, expect, it } from 'vitest';

import { mergeOpenCodeChatGptFastModeOptions } from './chatgpt-subscription';

describe('mergeOpenCodeChatGptFastModeOptions', () => {
  it('adds fast mode to supported ChatGPT defaults and preserves existing options', () => {
    const result = mergeOpenCodeChatGptFastModeOptions(
      {
        openai: {
          models: {
            'gpt-5.6-terra': { options: { reasoningEffort: 'high' } },
          },
        },
      },
      [
        'openai/gpt-6-astra',
        'openai/gpt-5.6-terra',
        'openai/gpt-5.6-sol',
        'openai/gpt-5.6-luna',
      ],
    );

    expect(result).toEqual({
      openai: {
        models: {
          'gpt-6-astra': { options: { serviceTier: 'priority' } },
          'gpt-5.6-terra': {
            options: { reasoningEffort: 'high', serviceTier: 'priority' },
          },
          'gpt-5.6-sol': { options: { serviceTier: 'priority' } },
          'gpt-5.6-luna': { options: { serviceTier: 'priority' } },
        },
      },
    });
  });

  it('ignores non-ChatGPT and unsupported OpenAI models', () => {
    const initial = {};

    expect(
      mergeOpenCodeChatGptFastModeOptions(initial, [
        'openrouter/openai/gpt-5.4',
        'openai/gpt-5.4-mini',
        'openai/gpt-5.3-codex-spark',
      ]),
    ).toBe(initial);
  });
});
