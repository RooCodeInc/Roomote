import { describe, expect, it } from 'vitest';

import {
  getSlackMentionDirectiveText,
  mentionsSlackBot,
  mentionsSlackUserOtherThanBot,
  mentionsSlackUserOtherThanBotOrUser,
  mentionsSlackUserOtherThanBotWithoutMentioningBot,
} from './mention-routing';

describe('mention-routing', () => {
  it('prefers authored text over enriched forwarded context', () => {
    const message = {
      authoredText: 'Can you take a look?',
      text: [
        'Can you take a look?',
        '',
        'Forwarded Slack message:',
        'Author: Alice',
        'Text:',
        '<@U777> can you check this?',
      ].join('\n'),
    };

    expect(getSlackMentionDirectiveText(message)).toBe('Can you take a look?');
    expect(mentionsSlackUserOtherThanBot(message, 'U_BOT')).toBe(false);
    expect(mentionsSlackBot(message, 'U_BOT')).toBe(false);
  });

  it('stops parsing when it reaches quoted lines', () => {
    const message = {
      text: [
        'Please review this',
        '> <@U777> old request',
        '<@U888> next',
      ].join('\n'),
    };

    expect(getSlackMentionDirectiveText(message)).toBe('Please review this');
    expect(mentionsSlackUserOtherThanBot(message, 'U_BOT')).toBe(false);
  });

  it('stops parsing when it reaches fenced code blocks', () => {
    const message = {
      text: [
        'Please review this',
        '```',
        '<@U777> copied from logs',
        '```',
      ].join('\n'),
    };

    expect(getSlackMentionDirectiveText(message)).toBe('Please review this');
    expect(mentionsSlackUserOtherThanBot(message, 'U_BOT')).toBe(false);
  });

  it('keeps mentions in later paragraphs inside the directive window', () => {
    const message = {
      text: ['hey', '', '<@U777> can you check this?'].join('\n'),
    };

    expect(getSlackMentionDirectiveText(message)).toBe(
      'hey <@U777> can you check this?',
    );
    expect(mentionsSlackUserOtherThanBot(message, 'U_BOT')).toBe(true);
    expect(
      mentionsSlackUserOtherThanBotWithoutMentioningBot(message, 'U_BOT'),
    ).toBe(true);
  });

  it('ignores the current user and bot when checking thread messages', () => {
    const message = {
      authoredText: [
        'Looping in <@U_BOT> and <@U_REQUESTER>',
        '',
        'No one else.',
      ].join('\n'),
      text: '',
    };

    expect(
      mentionsSlackUserOtherThanBotOrUser(message, 'U_BOT', 'U_REQUESTER'),
    ).toBe(false);
  });

  it('treats malformed messages without text as empty instead of throwing', () => {
    const message = {} as unknown as { text: string; authoredText?: string };

    expect(getSlackMentionDirectiveText(message)).toBe('');
    expect(mentionsSlackUserOtherThanBot(message, 'U_BOT')).toBe(false);
    expect(mentionsSlackBot(message, 'U_BOT')).toBe(false);
  });
});
