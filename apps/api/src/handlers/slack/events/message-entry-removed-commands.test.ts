import { describe, expect, it } from 'vitest';

import {
  getSlackSkillsCommandPage,
  isRemovedEvalCommandInvocation,
  shouldHandleSlackSkillsCommand,
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

  it('only intercepts direct messages or explicit Roomote mentions', () => {
    const event = (input: {
      channelType: string;
      text: string;
    }): Parameters<typeof shouldHandleSlackSkillsCommand>[0] =>
      ({
        type: 'message',
        channel: 'C1',
        channel_type: input.channelType,
        text: input.text,
        ts: '1',
        user: 'U1',
      }) as Parameters<typeof shouldHandleSlackSkillsCommand>[0];

    expect(
      shouldHandleSlackSkillsCommand(
        event({ channelType: 'im', text: 'skills' }),
        'U_ROOMOTE',
      ),
    ).toBe(true);
    expect(
      shouldHandleSlackSkillsCommand(
        event({ channelType: 'channel', text: '<@U_ROOMOTE> skills' }),
        'U_ROOMOTE',
      ),
    ).toBe(true);
    expect(
      shouldHandleSlackSkillsCommand(
        event({ channelType: 'channel', text: 'skills' }),
        'U_ROOMOTE',
      ),
    ).toBe(false);
    expect(
      shouldHandleSlackSkillsCommand(
        event({ channelType: 'channel', text: '<@U_OTHER> skills' }),
        'U_ROOMOTE',
      ),
    ).toBe(false);
  });
});
