import { describe, expect, it, vi, beforeEach } from 'vitest';

const {
  fetchThreadMessagesMock,
  hasPendingRoutingConfirmationMock,
  findRoomoteOwnedSlackThreadMock,
  markSlackThreadExplicitMentionRequiredMock,
  getSlackThreadReplyFooterMessageTsMock,
} = vi.hoisted(() => ({
  fetchThreadMessagesMock: vi.fn(),
  hasPendingRoutingConfirmationMock: vi.fn(),
  findRoomoteOwnedSlackThreadMock: vi.fn(),
  markSlackThreadExplicitMentionRequiredMock: vi.fn(),
  getSlackThreadReplyFooterMessageTsMock: vi.fn(),
}));

vi.mock('@roomote/env', () => ({
  Env: { TRPC_URL: null, R_APP_URL: 'http://localhost:3000' },
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  ROUTING_AUTO_CONFIRM_TIMEOUT_MS: 0,
}));

vi.mock('@roomote/cloud-agents', () => ({
  stripLeadingRawSlackMention: vi.fn((text: string) => text),
  stripLeadingSlackProductMention: vi.fn((text: string) => text),
}));

vi.mock('@roomote/slack', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/slack')>()),
  hasPendingRoutingConfirmation: hasPendingRoutingConfirmationMock,
  markSlackThreadExplicitMentionRequired:
    markSlackThreadExplicitMentionRequiredMock,
  getSlackThreadReplyFooterMessageTs: getSlackThreadReplyFooterMessageTsMock,
}));

vi.mock('../helpers/conversation-log.js', () => ({
  findRoomoteOwnedSlackThread: findRoomoteOwnedSlackThreadMock,
  findTrackedBackgroundAutomationSlackThread: vi.fn(),
  isRoomoteOwnedSlackThread: vi.fn(),
  recordInboundSlackConversationMessage: vi.fn(),
}));

vi.mock('@roomote/redis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/redis')>()),
  getRedis: () => ({
    sismember: vi.fn().mockResolvedValue(0),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    sadd: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
  }),
}));

vi.mock('@roomote/db/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/db/server')>()),
  db: {},
}));

const THREAD_TS = '100.000';
const BOT_USER_ID = 'UBOT';

const slackInstallation = {
  teamId: 'T123',
  botUserId: BOT_USER_ID,
  appId: 'A123',
} as never;

function humanMessage(user: string, ts: string, text = 'hello') {
  return { user, ts, text };
}

function botMessage(ts: string, text = 'bot reply') {
  return { user: BOT_USER_ID, bot_id: 'B999', ts, text };
}

function threadReplyEvent(params: { user: string; ts: string; text?: string }) {
  return {
    type: 'message',
    channel: 'C123',
    channel_type: 'channel',
    thread_ts: THREAD_TS,
    user: params.user,
    ts: params.ts,
    text: params.text ?? 'sounds good, keep going',
  } as never;
}

async function routeDecision(event: never) {
  const { shouldRouteUnmentionedSlackThreadReplyToAgent } =
    await import('./message-entry.js');

  return shouldRouteUnmentionedSlackThreadReplyToAgent({
    event,
    slack: { fetchThreadMessages: fetchThreadMessagesMock } as never,
    slackInstallation,
    teamId: 'T123',
  });
}

describe('shouldRouteUnmentionedSlackThreadReplyToAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasPendingRoutingConfirmationMock.mockResolvedValue(false);
    findRoomoteOwnedSlackThreadMock.mockResolvedValue({
      userId: 'user-1',
      slackUserId: 'U111',
    });
    markSlackThreadExplicitMentionRequiredMock.mockResolvedValue(undefined);
    getSlackThreadReplyFooterMessageTsMock.mockResolvedValue(null);
    fetchThreadMessagesMock.mockResolvedValue([]);
  });

  it('routes an unmentioned reply directly after the bot last spoke', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanMessage('U111', THREAD_TS, '<@UBOT> please fix the bug'),
      botMessage('101.000'),
    ]);

    await expect(
      routeDecision(threadReplyEvent({ user: 'U111', ts: '102.000' })),
    ).resolves.toMatchObject({ shouldRoute: true });
  }, 15_000);

  it('keeps routing consecutive replies from the same sender before the bot answers', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanMessage('U111', THREAD_TS, '<@UBOT> please fix the bug'),
      botMessage('101.000'),
      humanMessage('U111', '102.000', 'also add tests'),
    ]);

    await expect(
      routeDecision(threadReplyEvent({ user: 'U111', ts: '103.000' })),
    ).resolves.toMatchObject({ shouldRoute: true });
  });

  it('requires a mention when somebody else posted since the bot last spoke', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanMessage('U111', THREAD_TS, '<@UBOT> please fix the bug'),
      botMessage('101.000'),
      humanMessage('U222', '102.000', 'interesting thread'),
    ]);

    await expect(
      routeDecision(threadReplyEvent({ user: 'U111', ts: '103.000' })),
    ).resolves.toEqual({ shouldRoute: false });
    expect(markSlackThreadExplicitMentionRequiredMock).toHaveBeenCalledWith(
      'C123',
      THREAD_TS,
    );
  });

  it('requires a mention when somebody else was mentioned since the bot last spoke', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanMessage('U111', THREAD_TS, '<@UBOT> please fix the bug'),
      botMessage('101.000'),
      humanMessage('U111', '102.000', 'cc <@U333> for visibility'),
    ]);

    await expect(
      routeDecision(threadReplyEvent({ user: 'U111', ts: '103.000' })),
    ).resolves.toEqual({ shouldRoute: false });
    expect(markSlackThreadExplicitMentionRequiredMock).toHaveBeenCalledWith(
      'C123',
      THREAD_TS,
    );
  });

  it('reopens the no-mention window when the bot posts a new reply after an interjection', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanMessage('U111', THREAD_TS, '<@UBOT> please fix the bug'),
      botMessage('101.000'),
      humanMessage('U222', '102.000', 'interesting thread'),
      humanMessage('U111', '103.000', '<@UBOT> continue'),
      botMessage('104.000'),
    ]);

    await expect(
      routeDecision(threadReplyEvent({ user: 'U111', ts: '105.000' })),
    ).resolves.toMatchObject({ shouldRoute: true });
    expect(markSlackThreadExplicitMentionRequiredMock).not.toHaveBeenCalled();
  });

  it('ignores a first-time sender replying after the bot until they mention the bot', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanMessage('U111', THREAD_TS, '<@UBOT> please fix the bug'),
      botMessage('101.000'),
    ]);

    await expect(
      routeDecision(threadReplyEvent({ user: 'U222', ts: '102.000' })),
    ).resolves.toEqual({ shouldRoute: false });
  });

  it('lets a sender who joined via an earlier bot mention reply without a mention', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanMessage('U111', THREAD_TS, '<@UBOT> please fix the bug'),
      botMessage('101.000'),
      humanMessage('U222', '102.000', '<@UBOT> also update the docs'),
      botMessage('103.000'),
    ]);

    await expect(
      routeDecision(threadReplyEvent({ user: 'U222', ts: '104.000' })),
    ).resolves.toMatchObject({ shouldRoute: true });
  });

  it('lets the thread root author reply without a mention even without a prior bot mention', async () => {
    findRoomoteOwnedSlackThreadMock.mockResolvedValue({
      userId: null,
      slackUserId: null,
    });
    fetchThreadMessagesMock.mockResolvedValue([
      humanMessage('U111', THREAD_TS, 'please fix the login bug'),
      botMessage('101.000'),
    ]);

    await expect(
      routeDecision(threadReplyEvent({ user: 'U111', ts: '102.000' })),
    ).resolves.toMatchObject({ shouldRoute: true });
  });

  it('lets the thread task owner reply without a mention in a bot-started thread', async () => {
    findRoomoteOwnedSlackThreadMock.mockResolvedValue({
      userId: 'user-4',
      slackUserId: 'U444',
    });
    fetchThreadMessagesMock.mockResolvedValue([
      botMessage(THREAD_TS, 'Getting started on your task'),
      botMessage('101.000'),
    ]);

    await expect(
      routeDecision(threadReplyEvent({ user: 'U444', ts: '102.000' })),
    ).resolves.toMatchObject({ shouldRoute: true });
  });

  it('treats the whole thread as the window when no bot message is found in history', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanMessage('U111', THREAD_TS, '<@UBOT> please fix the bug'),
      humanMessage('U222', '101.000', 'interesting thread'),
    ]);

    await expect(
      routeDecision(threadReplyEvent({ user: 'U111', ts: '102.000' })),
    ).resolves.toEqual({ shouldRoute: false });
    expect(markSlackThreadExplicitMentionRequiredMock).toHaveBeenCalledWith(
      'C123',
      THREAD_TS,
    );
  });

  it('routes a single-sender thread without any bot message in history', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanMessage('U111', THREAD_TS, '<@UBOT> please fix the bug'),
    ]);

    await expect(
      routeDecision(threadReplyEvent({ user: 'U111', ts: '102.000' })),
    ).resolves.toMatchObject({ shouldRoute: true });
  });

  it('ignores messages that mention the bot (handled by the mention path)', async () => {
    await expect(
      routeDecision(
        threadReplyEvent({
          user: 'U111',
          ts: '102.000',
          text: '<@UBOT> please continue',
        }),
      ),
    ).resolves.toEqual({ shouldRoute: false });
    expect(fetchThreadMessagesMock).not.toHaveBeenCalled();
  });

  it('ignores replies that mention another user', async () => {
    await expect(
      routeDecision(
        threadReplyEvent({
          user: 'U111',
          ts: '102.000',
          text: '<@U333> what do you think?',
        }),
      ),
    ).resolves.toEqual({ shouldRoute: false });
    expect(fetchThreadMessagesMock).not.toHaveBeenCalled();
  });

  it('requires a mention when thread history comes back empty (failed fetch)', async () => {
    fetchThreadMessagesMock.mockResolvedValue([]);

    await expect(
      routeDecision(threadReplyEvent({ user: 'U111', ts: '102.000' })),
    ).resolves.toEqual({ shouldRoute: false });
  });

  it('routes a first-time sender replying in an automation report thread', async () => {
    findRoomoteOwnedSlackThreadMock.mockResolvedValue({
      userId: null,
      slackUserId: null,
      isAutomationReportThread: true,
    });
    fetchThreadMessagesMock.mockResolvedValue([
      botMessage(THREAD_TS, 'Automation report root'),
      botMessage('101.000'),
    ]);

    const decision = await routeDecision(
      threadReplyEvent({ user: 'U222', ts: '102.000' }),
    );

    expect(decision.shouldRoute).toBe(true);
  });

  it('ignores replies in threads Roomote does not own', async () => {
    findRoomoteOwnedSlackThreadMock.mockResolvedValue(null);

    await expect(
      routeDecision(threadReplyEvent({ user: 'U111', ts: '102.000' })),
    ).resolves.toEqual({ shouldRoute: false });
    expect(fetchThreadMessagesMock).not.toHaveBeenCalled();
  });
});
