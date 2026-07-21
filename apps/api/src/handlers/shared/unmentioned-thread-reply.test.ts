import { describe, expect, it } from 'vitest';

import {
  compareBigIntMessageIds,
  compareNumericMessageIds,
  evaluateUnmentionedThreadReplyRouting,
  type UnmentionedThreadHistoryMessage,
} from './unmentioned-thread-reply.js';

function human(
  id: string,
  authorUserId: string,
  options: { mentionsBot?: boolean; mentionsSomebodyElse?: boolean } = {},
): UnmentionedThreadHistoryMessage {
  return {
    id,
    authorUserId,
    isBot: false,
    mentionsBot: options.mentionsBot ?? false,
    mentionsSomebodyElse: options.mentionsSomebodyElse ?? false,
  };
}

function bot(id: string): UnmentionedThreadHistoryMessage {
  return {
    id,
    authorUserId: 'bot',
    isBot: true,
    mentionsBot: false,
    mentionsSomebodyElse: false,
  };
}

function decide(input: {
  eventMessageId?: string;
  senderUserId?: string;
  isThreadTaskOwner?: boolean;
  isThreadRootAuthor?: boolean;
  isAutomationReportThread?: boolean;
  threadMessages: UnmentionedThreadHistoryMessage[];
}) {
  return evaluateUnmentionedThreadReplyRouting({
    eventMessageId: input.eventMessageId ?? '500',
    senderUserId: input.senderUserId ?? 'U1',
    isThreadTaskOwner: input.isThreadTaskOwner ?? true,
    isThreadRootAuthor: input.isThreadRootAuthor ?? false,
    isAutomationReportThread: input.isAutomationReportThread ?? false,
    threadMessages: input.threadMessages,
    compareMessageIds: compareNumericMessageIds,
  });
}

describe('evaluateUnmentionedThreadReplyRouting', () => {
  it('routes an unmentioned reply directly after the bot last spoke', () => {
    expect(
      decide({
        threadMessages: [human('100', 'U1', { mentionsBot: true }), bot('200')],
      }),
    ).toEqual({ shouldRoute: true, interjectionDetected: false });
  });

  it('keeps routing consecutive replies from the same sender before the bot answers', () => {
    expect(
      decide({
        threadMessages: [
          human('100', 'U1', { mentionsBot: true }),
          bot('200'),
          human('300', 'U1'),
        ],
      }),
    ).toEqual({ shouldRoute: true, interjectionDetected: false });
  });

  it('requires a mention when somebody else posted since the bot last spoke', () => {
    expect(
      decide({
        threadMessages: [
          human('100', 'U1', { mentionsBot: true }),
          bot('200'),
          human('300', 'U2'),
        ],
      }),
    ).toEqual({ shouldRoute: false, interjectionDetected: true });
  });

  it('requires a mention when somebody else was mentioned since the bot last spoke', () => {
    expect(
      decide({
        threadMessages: [
          human('100', 'U1', { mentionsBot: true }),
          bot('200'),
          human('300', 'U1', { mentionsSomebodyElse: true }),
        ],
      }),
    ).toEqual({ shouldRoute: false, interjectionDetected: true });
  });

  it('reopens the no-mention window when the bot posts after an interjection', () => {
    expect(
      decide({
        threadMessages: [
          human('100', 'U1', { mentionsBot: true }),
          bot('200'),
          human('300', 'U2'),
          human('400', 'U1', { mentionsBot: true }),
          bot('450'),
        ],
      }),
    ).toEqual({ shouldRoute: true, interjectionDetected: false });
  });

  it('routes a first-time sender in an automation report thread', () => {
    expect(
      decide({
        isThreadTaskOwner: false,
        isThreadRootAuthor: false,
        isAutomationReportThread: true,
        threadMessages: [bot('100'), bot('200')],
      }),
    ).toEqual({ shouldRoute: true, interjectionDetected: false });
  });

  it('still requires a mention after an interjection in an automation report thread', () => {
    expect(
      decide({
        isThreadTaskOwner: false,
        isThreadRootAuthor: false,
        isAutomationReportThread: true,
        threadMessages: [bot('100'), human('200', 'U2')],
      }),
    ).toEqual({ shouldRoute: false, interjectionDetected: true });
  });

  it('rejects a first-time sender who never owned/rooted/mentioned', () => {
    expect(
      decide({
        isThreadTaskOwner: false,
        senderUserId: 'U2',
        threadMessages: [human('100', 'U1', { mentionsBot: true }), bot('200')],
      }),
    ).toEqual({ shouldRoute: false, interjectionDetected: false });
  });

  it('lets a prior bot-mentioner continue without ownership', () => {
    expect(
      decide({
        isThreadTaskOwner: false,
        senderUserId: 'U2',
        threadMessages: [
          human('100', 'U1', { mentionsBot: true }),
          bot('200'),
          human('300', 'U2', { mentionsBot: true }),
          bot('400'),
        ],
      }),
    ).toEqual({ shouldRoute: true, interjectionDetected: false });
  });

  it('lets a thread root author continue without a prior bot mention', () => {
    expect(
      decide({
        isThreadTaskOwner: false,
        isThreadRootAuthor: true,
        threadMessages: [human('100', 'U1'), bot('200')],
      }),
    ).toEqual({ shouldRoute: true, interjectionDetected: false });
  });

  it('treats the whole thread as the window when no bot message exists', () => {
    expect(
      decide({
        threadMessages: [
          human('100', 'U1', { mentionsBot: true }),
          human('200', 'U2'),
        ],
      }),
    ).toEqual({ shouldRoute: false, interjectionDetected: true });
  });

  it('returns empty history as not routable without interjection side effects', () => {
    expect(decide({ threadMessages: [] })).toEqual({
      shouldRoute: false,
      interjectionDetected: false,
    });
  });
});

describe('compare message ids', () => {
  it('orders numeric provider ids', () => {
    expect(compareNumericMessageIds('100.1', '100.2')).toBeLessThan(0);
    expect(compareNumericMessageIds('101', '100')).toBeGreaterThan(0);
  });

  it('orders Discord-style snowflake ids as bigints', () => {
    expect(
      compareBigIntMessageIds('100000000000000000', '200000000000000000'),
    ).toBeLessThan(0);
  });
});
