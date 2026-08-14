import { describe, expect, it } from 'vitest';

import {
  getSlackGoalCommandForEvent,
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

describe('Slack Goal Mode command routing', () => {
  it('accepts a bot-mentioned command in a channel thread', () => {
    expect(
      getSlackGoalCommandForEvent({
        type: 'app_mention',
        channel: 'C123',
        channel_type: 'channel',
        thread_ts: '100.000',
        user: 'U123',
        ts: '101.000',
        text: '<@UBOT> goal Ship the release',
      }),
    ).toEqual({ objective: 'Ship the release' });
  });

  it('accepts an unmentioned command in a direct message', () => {
    expect(
      getSlackGoalCommandForEvent({
        type: 'message',
        channel: 'D123',
        channel_type: 'im',
        user: 'U123',
        ts: '101.000',
        text: 'goal Ship the release',
      }),
    ).toEqual({ objective: 'Ship the release' });
  });

  it('does not treat unmentioned channel text as a command', () => {
    expect(
      getSlackGoalCommandForEvent({
        type: 'message',
        channel: 'C123',
        channel_type: 'channel',
        thread_ts: '100.000',
        user: 'U123',
        ts: '101.000',
        text: 'goal Ship the release',
      }),
    ).toBeNull();
  });

  it('waits for the app_mention event instead of handling the duplicate channel message', () => {
    expect(
      getSlackGoalCommandForEvent({
        type: 'message',
        channel: 'C123',
        channel_type: 'channel',
        thread_ts: '100.000',
        user: 'U123',
        ts: '101.000',
        text: '<@UBOT> goal Ship the release',
      }),
    ).toBeNull();
  });
});
