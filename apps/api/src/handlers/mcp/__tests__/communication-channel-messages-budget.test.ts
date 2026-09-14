import { describe, expect, it } from 'vitest';

import {
  applyChannelMessagesResultBudget,
  CHANNEL_MESSAGES_RESULT_BUDGET_CHARS,
} from '../communication-channel-messages-budget';
import type { CommunicationLookupMessage } from '../communication-message-lookup-types';

function message(index: number, textLength: number): CommunicationLookupMessage {
  return {
    provider: 'slack',
    id: `${1_700_000_000 + index}.000000`,
    user: `U${index}`,
    username: `User ${index}`,
    text: 'x'.repeat(textLength),
    channelId: 'C123',
    fileCount: 0,
  };
}

function payload(messages: CommunicationLookupMessage[]) {
  return {
    provider: 'slack' as const,
    channelId: 'C123',
    requestedOldest: '2026-09-01',
    messageCount: messages.length,
    messages,
  };
}

describe('applyChannelMessagesResultBudget', () => {
  it('returns small payloads untouched', () => {
    const input = payload([message(1, 50), message(2, 50)]);
    expect(applyChannelMessagesResultBudget(input)).toBe(input);
  });

  it('keeps the newest messages that fit and reports how to page back', () => {
    const messages = Array.from({ length: 200 }, (_, index) =>
      message(index, 600),
    );
    const result = applyChannelMessagesResultBudget(payload(messages));

    expect(result.truncated).toBe(true);
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.messageCount).toBe(result.messages.length);
    expect(result.omittedMessageCount).toBe(
      messages.length - result.messages.length,
    );
    expect(result.messages.at(-1)).toEqual(messages.at(-1));
    expect(result.nextLatest).toBe(result.messages[0]!.id);
    expect(result.note).toContain('nextLatest');
    expect(JSON.stringify(result, null, 2).length).toBeLessThanOrEqual(
      CHANNEL_MESSAGES_RESULT_BUDGET_CHARS,
    );
    expect(result.requestedOldest).toBe('2026-09-01');
  });

  it('honors a custom budget', () => {
    const messages = Array.from({ length: 10 }, (_, index) =>
      message(index, 100),
    );
    const result = applyChannelMessagesResultBudget(payload(messages), 900);

    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result, null, 2).length).toBeLessThanOrEqual(900);
    expect(result.messages.at(-1)).toEqual(messages.at(-1));
  });

  it('never drops below one message', () => {
    const result = applyChannelMessagesResultBudget(
      payload([message(1, 5_000), message(2, 5_000)]),
      100,
    );

    expect(result.messages).toEqual([message(2, 5_000)]);
    expect(result.omittedMessageCount).toBe(1);
  });
});
