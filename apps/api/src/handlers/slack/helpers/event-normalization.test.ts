import { describe, expect, it } from 'vitest';

import type { SlackEvent } from '@roomote/slack';

import { enrichSlackMessageEvent } from './event-normalization';

describe('event-normalization', () => {
  it('treats malformed message events without text as empty during enrichment', () => {
    const event = {
      type: 'message',
      channel: 'C123',
      user: 'U123',
      ts: '1712345678.000100',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'Where would an api log message like this come from?',
          },
        },
      ],
      text: undefined,
    } as unknown as SlackEvent;

    expect(() => enrichSlackMessageEvent(event)).not.toThrow();
    expect(event.authoredText).toBe('');
    expect(event.text).toBe(
      [
        'Slack block text:',
        'Where would an api log message like this come from?',
      ].join('\n'),
    );
  });

  it('treats malformed message events with no text key as empty during enrichment', () => {
    const event = {
      type: 'app_mention',
      channel: 'C123',
      user: 'U123',
      ts: '1712345678.000100',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '!fast check this thread',
          },
        },
      ],
    } as unknown as SlackEvent;

    expect(() => enrichSlackMessageEvent(event)).not.toThrow();
    expect(event.authoredText).toBe('');
    expect(event.text).toBe(
      ['Slack block text:', '!fast check this thread'].join('\n'),
    );
  });
});
