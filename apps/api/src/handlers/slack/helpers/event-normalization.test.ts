import { describe, expect, it } from 'vitest';

import type { SlackEvent } from '@roomote/slack';

import {
  enrichSlackMessageEvent,
  isRoutableAutomatedSlackAppMention,
} from './event-normalization';

describe('event-normalization', () => {
  const slackInstallation = {
    appId: 'A_ROOMOTE',
    botUserId: 'U_ROOMOTE',
  } as never;

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
    expect(event.agentContext).toBe(
      [
        'Slack block text:',
        'Where would an api log message like this come from?',
      ].join('\n'),
    );
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
    expect(event.agentContext).toBe(
      ['Slack block text:', '!fast check this thread'].join('\n'),
    );
    expect(event.text).toBe(
      ['Slack block text:', '!fast check this thread'].join('\n'),
    );
  });

  it('routes an external bot message that explicitly mentions Roomote', () => {
    const event = {
      type: 'message',
      subtype: 'bot_message',
      channel: 'C123',
      user: 'U_WORKFLOW',
      bot_id: 'B_WORKFLOW',
      app_id: 'A_WORKFLOW',
      text: '<@U_ROOMOTE> investigate this deployment',
      ts: '1712345678.000200',
    } as SlackEvent;

    expect(isRoutableAutomatedSlackAppMention(event, slackInstallation)).toBe(
      true,
    );
  });

  it('continues to route external app_mention events', () => {
    const event = {
      type: 'app_mention',
      channel: 'C123',
      user: 'U_WORKFLOW',
      bot_id: 'B_WORKFLOW',
      app_id: 'A_WORKFLOW',
      text: '<@U_ROOMOTE> investigate this deployment',
      ts: '1712345678.000250',
    } as SlackEvent;

    expect(isRoutableAutomatedSlackAppMention(event, slackInstallation)).toBe(
      true,
    );
  });

  it('does not route an external bot message without an explicit mention', () => {
    const event = {
      type: 'message',
      subtype: 'bot_message',
      channel: 'C123',
      user: 'U_WORKFLOW',
      bot_id: 'B_WORKFLOW',
      app_id: 'A_WORKFLOW',
      text: 'investigate this deployment',
      ts: '1712345678.000300',
    } as SlackEvent;

    expect(isRoutableAutomatedSlackAppMention(event, slackInstallation)).toBe(
      false,
    );
  });

  it('does not route bot messages authored by the Roomote app', () => {
    const event = {
      type: 'message',
      subtype: 'bot_message',
      channel: 'C123',
      user: 'U_WORKFLOW',
      bot_id: 'B_WORKFLOW',
      app_id: 'A_ROOMOTE',
      text: '<@U_ROOMOTE> investigate this deployment',
      ts: '1712345678.000400',
    } as SlackEvent;

    expect(isRoutableAutomatedSlackAppMention(event, slackInstallation)).toBe(
      false,
    );
  });

  it('does not route bot messages authored by the Roomote bot user', () => {
    const event = {
      type: 'message',
      subtype: 'bot_message',
      channel: 'C123',
      user: 'U_ROOMOTE',
      bot_id: 'B_WORKFLOW',
      app_id: 'A_WORKFLOW',
      text: '<@U_ROOMOTE> investigate this deployment',
      ts: '1712345678.000500',
    } as SlackEvent;

    expect(isRoutableAutomatedSlackAppMention(event, slackInstallation)).toBe(
      false,
    );
  });
});
