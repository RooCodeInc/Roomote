import { describe, expect, it } from 'vitest';

import { mergeOpenCodeChatGptFastModeOptions } from './chatgpt-subscription';

describe('mergeOpenCodeChatGptFastModeOptions', () => {
  it('adds fast mode to supported ChatGPT models and preserves existing options', () => {
    const result = mergeOpenCodeChatGptFastModeOptions(
      {
        openai: {
          models: {
            'gpt-5.4': { options: { reasoningEffort: 'high' } },
          },
        },
      },
      ['openai/gpt-5.4', 'openai/gpt-5.4'],
    );

    expect(result).toEqual({
      openai: {
        models: {
          'gpt-5.4': {
            options: { reasoningEffort: 'high', serviceTier: 'fast' },
          },
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
