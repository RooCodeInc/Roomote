import { describe, expect, it } from 'vitest';

import { isRemovedEvalCommandInvocation } from './message-entry.js';

describe('removed Slack commands', () => {
  it.each([
    '!eval investigate this',
    '  !EVAL --model openai/gpt-5 investigate this',
    '<@U123> !eval investigate this',
    '<@U123>: !eval investigate this',
  ])('recognizes removed eval invocation %s', (text) => {
    expect(isRemovedEvalCommandInvocation(text)).toBe(true);
  });

  it.each(['evaluate this', '!evaluation', '<@U123> investigate this'])(
    'does not intercept ordinary message %s',
    (text) => {
      expect(isRemovedEvalCommandInvocation(text)).toBe(false);
    },
  );
});
