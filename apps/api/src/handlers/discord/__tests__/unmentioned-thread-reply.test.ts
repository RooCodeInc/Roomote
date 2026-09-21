import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DiscordMessage } from '@roomote/communication/discord-event';

const { evaluateTypeSafeJudgmentsMock } = vi.hoisted(() => ({
  evaluateTypeSafeJudgmentsMock: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server/typesafe-judgment', () => ({
  evaluateTypeSafeJudgments: evaluateTypeSafeJudgmentsMock,
}));

import { shouldRouteUnmentionedDiscordThreadReplyToAgent } from '../unmentioned-thread-reply.js';
import type { DiscordThreadHistoryMessage } from '../thread-context.js';

const BOT_USER_ID = '9001';
const USER_1 = '1001';
const USER_2 = '1002';
const USER_3 = '1003';
const THREAD_CHANNEL_ID = '100';
const THREAD_ROOT_ID = THREAD_CHANNEL_ID;
const EVENT_ID = '500';

const fetchThreadMessagesMock = vi.fn();

function humanHistory(
  id: string,
  user: string,
  text = 'hello',
): DiscordThreadHistoryMessage {
  return { id, user, text, attachments: [] };
}

function botHistory(
  id: string,
  text = 'bot reply',
): DiscordThreadHistoryMessage {
  return {
    id,
    user: BOT_USER_ID,
    botId: BOT_USER_ID,
    text,
    attachments: [],
  };
}

function threadReplyMessage(params: {
  id?: string;
  user?: string;
  content?: string;
  mentions?: Array<{ id: string; username: string; bot?: boolean }>;
  messageSnapshots?: DiscordMessage['message_snapshots'];
}): DiscordMessage {
  const userId = params.user ?? USER_1;
  return {
    id: params.id ?? EVENT_ID,
    channel_id: THREAD_CHANNEL_ID,
    guild_id: 'guild-1',
    author: { id: userId, username: 'ada', bot: false },
    content: params.content ?? 'sounds good, keep going',
    mentions: params.mentions ?? [],
    attachments: [],
    ...(params.messageSnapshots
      ? { message_snapshots: params.messageSnapshots }
      : {}),
  } as DiscordMessage;
}

async function routeDecision(
  message: DiscordMessage,
  options: {
    mappedUserId?: string | null;
    ownedThreadUserId?: string | null;
    isRoomoteThread?: boolean;
    isAutomationReportThread?: boolean;
    isOpenConversationThread?: boolean;
    peerConversationsExperimentEnabled?: boolean;
    botUserId?: string;
  } = {},
) {
  return shouldRouteUnmentionedDiscordThreadReplyToAgent({
    message,
    botUserId:
      options.botUserId === undefined ? BOT_USER_ID : options.botUserId,
    mappedUserId:
      options.mappedUserId === undefined
        ? 'roomote-user-1'
        : options.mappedUserId,
    isRoomoteThread: options.isRoomoteThread ?? true,
    ownedThreadUserId:
      options.ownedThreadUserId === undefined
        ? 'roomote-user-1'
        : options.ownedThreadUserId,
    isOpenConversationThread: options.isOpenConversationThread,
    peerConversationsExperimentEnabled:
      options.peerConversationsExperimentEnabled,
    isAutomationReportThread: options.isAutomationReportThread,
    fetchThreadMessages: fetchThreadMessagesMock,
  });
}

describe('shouldRouteUnmentionedDiscordThreadReplyToAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchThreadMessagesMock.mockResolvedValue(null);
    evaluateTypeSafeJudgmentsMock.mockResolvedValue(null);
  });

  it('routes an unmentioned reply directly after the bot last spoke', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanHistory(
        THREAD_ROOT_ID,
        USER_1,
        `<@${BOT_USER_ID}> please fix the bug`,
      ),
      botHistory('200'),
    ]);

    await expect(routeDecision(threadReplyMessage({}))).resolves.toBe(true);
  });

  it('routes a linked first-time reply to a bot-authored automation report', async () => {
    fetchThreadMessagesMock.mockResolvedValue([botHistory(THREAD_ROOT_ID)]);

    await expect(
      routeDecision(threadReplyMessage({}), {
        ownedThreadUserId: null,
        isAutomationReportThread: true,
      }),
    ).resolves.toBe(true);
  });

  it.each([
    humanHistory('300', USER_2, 'interesting report'),
    humanHistory('300', USER_1, `cc <@${USER_3}> for visibility`),
  ])(
    'keeps automation report interjection and chatter guards for $text',
    async (interjection) => {
      fetchThreadMessagesMock.mockResolvedValue([
        botHistory(THREAD_ROOT_ID),
        interjection,
      ]);

      await expect(
        routeDecision(threadReplyMessage({}), {
          ownedThreadUserId: null,
          isAutomationReportThread: true,
        }),
      ).resolves.toBe(false);
    },
  );

  it("routes Matt when he joins Dan's open fast-agent thread", async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanHistory(THREAD_ROOT_ID, USER_1, 'Can you summarize this?'),
      botHistory('200', 'Hi Dan.'),
    ]);

    await expect(
      routeDecision(
        threadReplyMessage({
          user: USER_2,
          content: 'Hey Roomote, can you check this too?',
        }),
        {
          mappedUserId: 'roomote-user-matt',
          ownedThreadUserId: 'roomote-user-dan',
          isOpenConversationThread: true,
        },
      ),
    ).resolves.toBe(true);
  });

  it('keeps a reply silent when the previous participant addressed the sender in an open fast-agent thread', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanHistory(THREAD_ROOT_ID, USER_1, 'Can you summarize this?'),
      botHistory('200', 'Hi there.'),
      humanHistory('300', USER_1, `<@${USER_2}> what do you think?`),
    ]);

    await expect(
      routeDecision(threadReplyMessage({ user: USER_2, content: 'I agree' }), {
        mappedUserId: 'roomote-user-2',
        ownedThreadUserId: 'roomote-user-1',
        isOpenConversationThread: true,
      }),
    ).resolves.toBe(false);
  });

  it('keeps routing after the sender mentions themself in an open fast-agent thread', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanHistory(THREAD_ROOT_ID, USER_1, 'Can you summarize this?'),
      botHistory('200', 'Hi there.'),
      humanHistory('300', USER_1, `<@${USER_1}> note to self`),
    ]);

    await expect(
      routeDecision(threadReplyMessage({ user: USER_1 }), {
        isOpenConversationThread: true,
      }),
    ).resolves.toBe(true);
  });

  it('keeps routing consecutive replies from the same sender before the bot answers', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanHistory(
        THREAD_ROOT_ID,
        USER_1,
        `<@${BOT_USER_ID}> please fix the bug`,
      ),
      botHistory('200'),
      humanHistory('300', USER_1, 'also add tests'),
    ]);

    await expect(routeDecision(threadReplyMessage({}))).resolves.toBe(true);
  });

  it('requires a mention when somebody else posted since the bot last spoke', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanHistory(
        THREAD_ROOT_ID,
        USER_1,
        `<@${BOT_USER_ID}> please fix the bug`,
      ),
      botHistory('200'),
      humanHistory('300', USER_2, 'interesting thread'),
    ]);

    await expect(routeDecision(threadReplyMessage({}))).resolves.toBe(false);
  });

  it('routes an interjected reply the judgment model confidently gives to Roomote', async () => {
    evaluateTypeSafeJudgmentsMock.mockResolvedValue({
      addressee: {
        type: 'choice',
        choice: 'roomote',
        confidence: 0.95,
        probabilities: { roomote: 0.95, participant: 0.03, unclear: 0.02 },
      },
    });
    fetchThreadMessagesMock.mockResolvedValue([
      humanHistory(
        THREAD_ROOT_ID,
        USER_1,
        `<@${BOT_USER_ID}> please fix the bug`,
      ),
      botHistory('200'),
      humanHistory('300', USER_2, 'interesting thread'),
    ]);

    await expect(
      routeDecision(
        threadReplyMessage({ content: 'can you also add a unit test?' }),
      ),
    ).resolves.toBe(true);
    expect(evaluateTypeSafeJudgmentsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        state: expect.objectContaining({
          reply: {
            author: 'reply author',
            text: 'can you also add a unit test?',
          },
        }),
      }),
    );
  });

  it('requires a mention when somebody else was mentioned since the bot last spoke', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanHistory(
        THREAD_ROOT_ID,
        USER_1,
        `<@${BOT_USER_ID}> please fix the bug`,
      ),
      botHistory('200'),
      humanHistory('300', USER_1, `cc <@${USER_3}> for visibility`),
    ]);

    await expect(routeDecision(threadReplyMessage({}))).resolves.toBe(false);
  });

  it('reopens the no-mention window when the bot posts a new reply after an interjection', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanHistory(
        THREAD_ROOT_ID,
        USER_1,
        `<@${BOT_USER_ID}> please fix the bug`,
      ),
      botHistory('200'),
      humanHistory('300', USER_2, 'interesting thread'),
      humanHistory('400', USER_1, `<@${BOT_USER_ID}> continue`),
      botHistory('450'),
    ]);

    await expect(routeDecision(threadReplyMessage({}))).resolves.toBe(true);
  });

  it('ignores a first-time sender replying after the bot until they mention the bot', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanHistory(
        THREAD_ROOT_ID,
        USER_1,
        `<@${BOT_USER_ID}> please fix the bug`,
      ),
      botHistory('200'),
    ]);

    await expect(
      routeDecision(threadReplyMessage({ user: USER_2 }), {
        mappedUserId: 'roomote-user-2',
        ownedThreadUserId: 'roomote-user-1',
      }),
    ).resolves.toBe(false);
  });

  it('lets a sender who joined via an earlier bot mention reply without a mention', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanHistory(
        THREAD_ROOT_ID,
        USER_1,
        `<@${BOT_USER_ID}> please fix the bug`,
      ),
      botHistory('200'),
      humanHistory('300', USER_2, `<@${BOT_USER_ID}> also update the docs`),
      botHistory('400'),
    ]);

    await expect(
      routeDecision(threadReplyMessage({ user: USER_2 }), {
        mappedUserId: 'roomote-user-2',
        ownedThreadUserId: 'roomote-user-1',
      }),
    ).resolves.toBe(true);
  });

  it('lets the thread root author reply without a mention even without a prior bot mention', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanHistory(THREAD_ROOT_ID, USER_1, 'please fix the login bug'),
      botHistory('200'),
    ]);

    await expect(
      routeDecision(threadReplyMessage({}), {
        ownedThreadUserId: 'someone-else',
      }),
    ).resolves.toBe(true);
  });

  it('does not treat the oldest retained message as root when the real starter is absent', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      // Truncated window: oldest retained message is not the thread starter
      // (starter id === thread channel id is missing).
      humanHistory('150', USER_2, 'mid-thread chatter after truncation'),
      botHistory('200'),
    ]);

    await expect(
      routeDecision(threadReplyMessage({ user: USER_2 }), {
        mappedUserId: 'roomote-user-2',
        ownedThreadUserId: 'roomote-user-1',
      }),
    ).resolves.toBe(false);
  });

  it('lets the thread task owner reply without a mention in a bot-started thread', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      botHistory(THREAD_ROOT_ID, 'Getting started on your task'),
      botHistory('200'),
    ]);

    await expect(routeDecision(threadReplyMessage({}))).resolves.toBe(true);
  });

  it('treats the whole thread as the window when no bot message is found in history', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanHistory(
        THREAD_ROOT_ID,
        USER_1,
        `<@${BOT_USER_ID}> please fix the bug`,
      ),
      humanHistory('200', USER_2, 'interesting thread'),
    ]);

    await expect(routeDecision(threadReplyMessage({}))).resolves.toBe(false);
  });

  it('does not route when the current message mentions someone else without the bot', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanHistory(
        THREAD_ROOT_ID,
        USER_1,
        `<@${BOT_USER_ID}> please fix the bug`,
      ),
      botHistory('200'),
    ]);

    await expect(
      routeDecision(
        threadReplyMessage({
          content: `hey <@${USER_3}> look at this`,
          mentions: [{ id: USER_3, username: 'grace' }],
        }),
      ),
    ).resolves.toBe(false);
    expect(evaluateTypeSafeJudgmentsMock).not.toHaveBeenCalled();
  });

  it('routes peer discussion in an opted-in open Fast conversation', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanHistory(THREAD_ROOT_ID, USER_1, 'Can you summarize this?'),
      botHistory('200', 'Hi there.'),
    ]);

    await expect(
      routeDecision(
        threadReplyMessage({
          content: `hey <@${USER_3}> look at this`,
          mentions: [{ id: USER_3, username: 'grace' }],
        }),
        {
          isOpenConversationThread: true,
          peerConversationsExperimentEnabled: true,
        },
      ),
    ).resolves.toBe(true);
    expect(fetchThreadMessagesMock).toHaveBeenCalledOnce();
  });

  it('keeps subsequent ambient turns in the opted-in Fast conversation', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanHistory(THREAD_ROOT_ID, USER_1, 'Can you summarize this?'),
      botHistory('200', 'Hi there.'),
    ]);

    await expect(
      routeDecision(threadReplyMessage({ content: 'I agree' }), {
        isOpenConversationThread: true,
        peerConversationsExperimentEnabled: true,
      }),
    ).resolves.toBe(true);
    expect(fetchThreadMessagesMock).toHaveBeenCalledOnce();
  });

  it('gates an opted-in peer message with the configured judgment model', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanHistory(THREAD_ROOT_ID, USER_1, 'Can you summarize this?'),
      botHistory('200', 'Hi there.'),
    ]);
    evaluateTypeSafeJudgmentsMock.mockResolvedValue({
      addressee: {
        type: 'choice',
        choice: 'participant',
        confidence: 0.92,
        probabilities: { roomote: 0.03, participant: 0.92, unclear: 0.05 },
      },
    });

    await expect(
      routeDecision(threadReplyMessage({ content: 'I agree' }), {
        isOpenConversationThread: true,
        peerConversationsExperimentEnabled: true,
      }),
    ).resolves.toBe(false);
    expect(fetchThreadMessagesMock).toHaveBeenCalledOnce();
    expect(evaluateTypeSafeJudgmentsMock).toHaveBeenCalledOnce();
  });

  it('does not route a forwarded snapshot that mentions someone else', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanHistory(
        THREAD_ROOT_ID,
        USER_1,
        `<@${BOT_USER_ID}> please fix the bug`,
      ),
      botHistory('200'),
    ]);

    await expect(
      routeDecision(
        threadReplyMessage({
          content: '',
          messageSnapshots: [
            {
              message: {
                content: `hey <@${USER_3}> look at this`,
                mentions: [{ id: USER_3, username: 'grace' }],
                attachments: [],
              },
            },
          ],
        }),
      ),
    ).resolves.toBe(false);
  });

  it('uses resolved forwarded snapshot mentions when checking the recipient', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanHistory(
        THREAD_ROOT_ID,
        USER_1,
        `<@${BOT_USER_ID}> please fix the bug`,
      ),
      botHistory('200'),
    ]);

    await expect(
      routeDecision(
        threadReplyMessage({
          content: '',
          messageSnapshots: [
            {
              message: {
                content: 'hey Grace, look at this',
                mentions: [{ id: USER_3, username: 'grace' }],
                attachments: [],
              },
            },
          ],
        }),
      ),
    ).resolves.toBe(false);
  });

  it('does not route when thread history cannot be fetched', async () => {
    fetchThreadMessagesMock.mockResolvedValue(null);

    await expect(routeDecision(threadReplyMessage({}))).resolves.toBe(false);
  });

  it('does not route unmentioned replies outside a Roomote thread', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanHistory(
        THREAD_ROOT_ID,
        USER_1,
        `<@${BOT_USER_ID}> please fix the bug`,
      ),
      botHistory('200'),
    ]);

    await expect(
      routeDecision(threadReplyMessage({}), {
        isRoomoteThread: false,
        isOpenConversationThread: true,
        peerConversationsExperimentEnabled: true,
      }),
    ).resolves.toBe(false);
  });
});
