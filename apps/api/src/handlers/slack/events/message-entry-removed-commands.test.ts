import { describe, expect, it } from 'vitest';

import {
  getSlackSkillsCommandPage,
  isRemovedEvalCommandInvocation,
} from './message-entry.js';

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

describe('Slack skills command', () => {
  it('accepts DM-style and mention-prefixed commands only', () => {
    expect(getSlackSkillsCommandPage('skills')).toBe(1);
    expect(getSlackSkillsCommandPage('/skills 2')).toBe(2);
    expect(getSlackSkillsCommandPage('<@U_ROOMOTE> skills 3')).toBe(3);
    expect(getSlackSkillsCommandPage('please show skills')).toBeNull();
    expect(
      getSlackSkillsCommandPage('<@U_OTHER> please show skills'),
    ).toBeNull();
  });
});
