import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockEvaluateTypeSafeJudgments } = vi.hoisted(() => ({
  mockEvaluateTypeSafeJudgments: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server/typesafe-judgment', () => ({
  evaluateTypeSafeJudgments: mockEvaluateTypeSafeJudgments,
}));

import {
  compareBigIntMessageIds,
  compareNumericMessageIds,
  evaluateUnmentionedThreadReplyRouting,
  resolveUnmentionedThreadReplyRouting,
  type UnmentionedThreadHistoryMessage,
} from './unmentioned-thread-reply.js';

function human(
  id: string,
  authorUserId: string,
  options: {
    mentionsBot?: boolean;
    mentionsSomebodyElse?: boolean;
    text?: string;
  } = {},
): UnmentionedThreadHistoryMessage {
  return {
    id,
    authorUserId,
    isBot: false,
    mentionsBot: options.mentionsBot ?? false,
    mentionsSomebodyElse: options.mentionsSomebodyElse ?? false,
    ...(options.text !== undefined ? { text: options.text } : {}),
  };
}

function bot(id: string, text?: string): UnmentionedThreadHistoryMessage {
  return {
    id,
    authorUserId: 'bot',
    isBot: true,
    mentionsBot: false,
    mentionsSomebodyElse: false,
    ...(text !== undefined ? { text } : {}),
  };
}

function decide(input: {
  eventMessageId?: string;
  senderUserId?: string;
  isThreadTaskOwner?: boolean;
  isThreadRootAuthor?: boolean;
  isAutomationReportThread?: boolean;
  isOpenConversationThread?: boolean;
  threadMessages: UnmentionedThreadHistoryMessage[];
}) {
  return evaluateUnmentionedThreadReplyRouting({
    eventMessageId: input.eventMessageId ?? '500',
    senderUserId: input.senderUserId ?? 'U1',
    isThreadTaskOwner: input.isThreadTaskOwner ?? true,
    isThreadRootAuthor: input.isThreadRootAuthor ?? false,
    isAutomationReportThread: input.isAutomationReportThread ?? false,
    isOpenConversationThread: input.isOpenConversationThread ?? false,
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

  it('routes a first-time sender in an open Roomote conversation', () => {
    expect(
      decide({
        isThreadTaskOwner: false,
        isThreadRootAuthor: false,
        isOpenConversationThread: true,
        senderUserId: 'U2',
        threadMessages: [human('100', 'U1', { mentionsBot: true }), bot('200')],
      }),
    ).toEqual({ shouldRoute: true, interjectionDetected: false });
  });

  it('routes a new sender after another participant speaks in an open Roomote conversation', () => {
    expect(
      decide({
        isThreadTaskOwner: false,
        isThreadRootAuthor: false,
        isOpenConversationThread: true,
        senderUserId: 'U2',
        threadMessages: [
          human('100', 'U1', { mentionsBot: true }),
          bot('200'),
          human('300', 'U1'),
        ],
      }),
    ).toEqual({ shouldRoute: true, interjectionDetected: false });
  });

  it('still requires a mention when somebody else was mentioned in an open Roomote conversation', () => {
    expect(
      decide({
        isOpenConversationThread: true,
        threadMessages: [
          human('100', 'U1', { mentionsBot: true }),
          bot('200'),
          human('300', 'U1', { mentionsSomebodyElse: true }),
        ],
      }),
    ).toEqual({ shouldRoute: false, interjectionDetected: true });
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

function addresseeAnswer(
  choice: 'roomote' | 'participant' | 'unclear',
  probability: number,
) {
  const rest = (1 - probability) / 2;
  return {
    addressee: {
      type: 'choice',
      choice,
      confidence: probability,
      probabilities: {
        roomote: choice === 'roomote' ? probability : rest,
        participant: choice === 'participant' ? probability : rest,
        unclear: choice === 'unclear' ? probability : rest,
      },
    },
  };
}

describe('resolveUnmentionedThreadReplyRouting', () => {
  const interjectedThread = [
    human('100', 'U1', { mentionsBot: true, text: 'please fix the bug' }),
    bot('200', 'I opened a PR with the fix.'),
    human('300', 'U2', { text: 'nice, looks good' }),
    human('600', 'U2', { text: 'a later message' }),
  ];

  function resolve(
    input: {
      senderUserId?: string;
      isThreadTaskOwner?: boolean;
      isOpenConversationThread?: boolean;
      threadMessages?: UnmentionedThreadHistoryMessage[];
      eventText?: string;
    } = {},
  ) {
    return resolveUnmentionedThreadReplyRouting({
      eventMessageId: '500',
      eventText: input.eventText ?? 'can you also add a test?',
      senderUserId: input.senderUserId ?? 'U1',
      isThreadTaskOwner: input.isThreadTaskOwner ?? true,
      isThreadRootAuthor: false,
      isOpenConversationThread: input.isOpenConversationThread ?? false,
      threadMessages: input.threadMessages ?? interjectedThread,
      compareMessageIds: compareNumericMessageIds,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockEvaluateTypeSafeJudgments.mockResolvedValue(null);
  });

  it('keeps the interjection refusal when the judgment model is not configured', async () => {
    await expect(resolve()).resolves.toEqual({
      shouldRoute: false,
      interjectionDetected: true,
    });
    expect(mockEvaluateTypeSafeJudgments).toHaveBeenCalledOnce();
  });

  it('routes an interjected reply the judgment model confidently gives to Roomote', async () => {
    mockEvaluateTypeSafeJudgments.mockResolvedValue(
      addresseeAnswer('roomote', 0.9),
    );

    await expect(resolve()).resolves.toEqual({
      shouldRoute: true,
      interjectionDetected: false,
      routedByJudgmentModel: true,
    });

    const { state } = mockEvaluateTypeSafeJudgments.mock.calls[0]![0];
    expect(state).toEqual({
      thread: {
        messages: [
          {
            author: 'reply author',
            text: 'please fix the bug',
            mentionsRoomote: true,
            mentionsSomebodyElse: false,
          },
          {
            author: 'Roomote',
            text: 'I opened a PR with the fix.',
            mentionsRoomote: false,
            mentionsSomebodyElse: false,
          },
          {
            author: 'participant 1',
            text: 'nice, looks good',
            mentionsRoomote: false,
            mentionsSomebodyElse: false,
          },
        ],
      },
      reply: { author: 'reply author', text: 'can you also add a test?' },
    });
  });

  it('keeps the refusal when Roomote is the likeliest addressee but below the threshold', async () => {
    mockEvaluateTypeSafeJudgments.mockResolvedValue(
      addresseeAnswer('roomote', 0.7),
    );

    await expect(resolve()).resolves.toEqual({
      shouldRoute: false,
      interjectionDetected: true,
    });
  });

  it('keeps the refusal when the judgment model says the reply is for a participant', async () => {
    mockEvaluateTypeSafeJudgments.mockResolvedValue(
      addresseeAnswer('participant', 0.95),
    );

    await expect(resolve()).resolves.toEqual({
      shouldRoute: false,
      interjectionDetected: true,
    });
  });

  it('keeps the refusal when the judgment model fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockEvaluateTypeSafeJudgments.mockRejectedValue(new Error('timeout'));

    await expect(resolve()).resolves.toEqual({
      shouldRoute: false,
      interjectionDetected: true,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[UnmentionedThreadReply]'),
    );
    warn.mockRestore();
  });

  it('keeps the refusal when the judgment response is malformed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockEvaluateTypeSafeJudgments.mockRejectedValue(
      new Error('Judgment model response is missing a valid answer'),
    );

    await expect(resolve()).resolves.toEqual({
      shouldRoute: false,
      interjectionDetected: true,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('missing a valid answer'),
    );
    warn.mockRestore();
  });

  it('keeps legacy routing when the optional judgment backend is unavailable', async () => {
    await expect(resolve({ eventText: '   ' })).resolves.toEqual({
      shouldRoute: false,
      interjectionDetected: true,
    });
    expect(mockEvaluateTypeSafeJudgments).toHaveBeenCalledOnce();
  });

  it('consults the judgment model once when the heuristic admits a reply', async () => {
    await expect(
      resolve({ threadMessages: [human('100', 'U1'), bot('200')] }),
    ).resolves.toEqual({ shouldRoute: true, interjectionDetected: false });
    expect(mockEvaluateTypeSafeJudgments).toHaveBeenCalledOnce();
  });

  it('routes a clear unmentioned follow-up to Roomote', async () => {
    mockEvaluateTypeSafeJudgments.mockResolvedValue(
      addresseeAnswer('roomote', 0.9),
    );

    await expect(
      resolve({ eventText: 'Can you also add a regression test?' }),
    ).resolves.toEqual({
      shouldRoute: true,
      interjectionDetected: false,
      routedByJudgmentModel: true,
    });
  });

  it.each([
    [
      'a human-to-human question',
      'Dan, can you send me the logs?',
      'participant',
    ],
    ['an ambiguous thanks', 'Sounds good, thanks', 'unclear'],
    ['a peer-conversation apology', 'Sorry for the ping', 'participant'],
  ] as const)(
    'suppresses %s even when the heuristic would admit it',
    async (_label, eventText, choice) => {
      mockEvaluateTypeSafeJudgments.mockResolvedValue(
        addresseeAnswer(choice, 0.9),
      );

      await expect(
        resolve({
          eventText,
          threadMessages: [human('100', 'U1'), bot('200')],
        }),
      ).resolves.toEqual({ shouldRoute: false, interjectionDetected: false });
    },
  );

  it('suppresses a changing-speaker continuation addressed to another participant', async () => {
    mockEvaluateTypeSafeJudgments.mockResolvedValue(
      addresseeAnswer('participant', 0.95),
    );

    await expect(
      resolve({
        senderUserId: 'U3',
        isOpenConversationThread: true,
        threadMessages: [
          human('100', 'U1', { mentionsBot: true, text: 'please investigate' }),
          bot('200', 'I found the issue.'),
          human('300', 'U2', { text: 'I agree with that.' }),
        ],
      }),
    ).resolves.toEqual({
      shouldRoute: false,
      interjectionDetected: false,
    });
  });

  it('fails closed when a configured judgment model is unavailable', async () => {
    mockEvaluateTypeSafeJudgments.mockRejectedValue(new Error('timeout'));

    await expect(
      resolve({
        eventText: 'Sounds good',
        threadMessages: [human('100', 'U1'), bot('200')],
      }),
    ).resolves.toEqual({
      shouldRoute: false,
      interjectionDetected: false,
    });
  });

  it('fails closed when a configured judgment answer is malformed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockEvaluateTypeSafeJudgments.mockResolvedValue({
      addressee: {
        type: 'choice',
        choice: 'roomote',
        confidence: 0.95,
        probabilities: { roomote: Number.NaN },
      },
    });

    await expect(
      resolve({
        eventText: 'Can you check this?',
        threadMessages: [human('100', 'U1'), bot('200')],
      }),
    ).resolves.toEqual({
      shouldRoute: false,
      interjectionDetected: false,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid'));
    warn.mockRestore();
  });

  it('never consults the judgment model for an ineligible sender', async () => {
    mockEvaluateTypeSafeJudgments.mockResolvedValue(
      addresseeAnswer('roomote', 1),
    );

    await expect(
      resolve({ senderUserId: 'U3', isThreadTaskOwner: false }),
    ).resolves.toEqual({ shouldRoute: false, interjectionDetected: false });
    expect(mockEvaluateTypeSafeJudgments).not.toHaveBeenCalled();
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
