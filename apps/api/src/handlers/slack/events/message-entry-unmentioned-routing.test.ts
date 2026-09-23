import { describe, expect, it, vi, beforeEach } from 'vitest';

const {
  fetchThreadMessagesMock,
  hasPendingRoutingConfirmationMock,
  findRoomoteOwnedSlackThreadMock,
  markSlackThreadExplicitMentionRequiredMock,
  acquireRootBindingLockMock,
  releaseRootBindingLockMock,
  getFastAgentSessionOwnerMock,
  findActiveSlackTaskRunMock,
  findCompletedSlackTaskRunWithSnapshotMock,
  evaluateTypeSafeJudgmentsMock,
  lookupSlackUserMappingMock,
  recordInboundSlackConversationMessageMock,
  processFastAgentMessageMock,
  findSessionAttentionNotificationReplyMock,
  stopChatSessionTasksMock,
} = vi.hoisted(() => ({
  fetchThreadMessagesMock: vi.fn(),
  hasPendingRoutingConfirmationMock: vi.fn(),
  findRoomoteOwnedSlackThreadMock: vi.fn(),
  markSlackThreadExplicitMentionRequiredMock: vi.fn(),
  acquireRootBindingLockMock: vi.fn(),
  releaseRootBindingLockMock: vi.fn(),
  getFastAgentSessionOwnerMock: vi.fn(),
  findActiveSlackTaskRunMock: vi.fn(),
  findCompletedSlackTaskRunWithSnapshotMock: vi.fn(),
  evaluateTypeSafeJudgmentsMock: vi.fn(),
  lookupSlackUserMappingMock: vi.fn(),
  recordInboundSlackConversationMessageMock: vi.fn(),
  processFastAgentMessageMock: vi.fn(),
  findSessionAttentionNotificationReplyMock: vi.fn(),
  stopChatSessionTasksMock: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server/typesafe-judgment', () => ({
  evaluateTypeSafeJudgments: evaluateTypeSafeJudgmentsMock,
}));

vi.mock('@roomote/env', () => ({
  Env: { TRPC_URL: null, R_APP_URL: 'http://localhost:3000' },
}));

vi.mock('@roomote/cloud-agents/server', () => ({
  ROUTING_AUTO_CONFIRM_TIMEOUT_MS: 0,
  getFastAgentSessionOwner: getFastAgentSessionOwnerMock,
}));

vi.mock('@roomote/cloud-agents', () => ({
  stripLeadingRawSlackMention: vi.fn((text: string) => text),
  stripLeadingSlackProductMention: vi.fn((text: string) => text),
}));

vi.mock('@roomote/sdk/server', () => ({
  findSessionAttentionNotificationReply:
    findSessionAttentionNotificationReplyMock,
}));

vi.mock('@roomote/slack', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/slack')>()),
  acquireSlackFastRootBindingLock: acquireRootBindingLockMock,
  createFastAgentSlackLiveTaskLauncher: vi.fn(() => vi.fn()),
  hasPendingRoutingConfirmation: hasPendingRoutingConfirmationMock,
  markSlackThreadExplicitMentionRequired:
    markSlackThreadExplicitMentionRequiredMock,
  findActiveSlackTaskRun: findActiveSlackTaskRunMock,
  findCompletedSlackTaskRunWithSnapshot:
    findCompletedSlackTaskRunWithSnapshotMock,
}));

vi.mock('../helpers/conversation-log.js', () => ({
  findRoomoteOwnedSlackThread: findRoomoteOwnedSlackThreadMock,
  findTrackedBackgroundAutomationSlackThread: vi.fn(),
  isRoomoteOwnedSlackThread: vi.fn(),
  recordInboundSlackConversationMessage:
    recordInboundSlackConversationMessageMock,
}));

vi.mock('../helpers/user-mapping.js', () => ({
  lookupSlackUserMapping: lookupSlackUserMappingMock,
}));

vi.mock('./fast-agent.js', () => ({
  processFastAgentMessage: processFastAgentMessageMock,
}));

vi.mock('../../tasks/session-stop-command.js', () => ({
  stopChatSessionTasks: stopChatSessionTasksMock,
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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
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
    acquireRootBindingLockMock.mockResolvedValue(releaseRootBindingLockMock);
    releaseRootBindingLockMock.mockResolvedValue(undefined);
    getFastAgentSessionOwnerMock.mockResolvedValue(null);
    findActiveSlackTaskRunMock.mockResolvedValue(null);
    findCompletedSlackTaskRunWithSnapshotMock.mockResolvedValue(null);
    fetchThreadMessagesMock.mockResolvedValue([]);
    evaluateTypeSafeJudgmentsMock.mockResolvedValue(null);
    processFastAgentMessageMock.mockImplementation(
      async ({ onAccepted }: { onAccepted?: (abort: () => void) => void }) => {
        onAccepted?.(() => {});
      },
    );
    findSessionAttentionNotificationReplyMock.mockResolvedValue({
      status: 'none',
    });
    lookupSlackUserMappingMock.mockResolvedValue({
      activeMapping: { userId: 'user-1', slackUserId: 'U111' },
    });
    stopChatSessionTasksMock.mockResolvedValue({
      kind: 'stopped',
      stoppedCount: 2,
      text: 'Stopped 2 active tasks. The work remains resumable; send another message here to continue.',
    });
  });

  it('handles an explicit Slack stop request before normal Fast message routing', async () => {
    const { handleMessageOrAppMentionEvent } =
      await import('./message-entry.js');
    const event = {
      type: 'app_mention',
      channel: 'C123',
      channel_type: 'channel',
      ts: '101.000',
      thread_ts: '100.000',
      user: 'U111',
      text: '<@UBOT> stop',
    } as never;
    const postMessage = vi.fn().mockResolvedValue(undefined);
    const context = {
      slackInstallation,
      slack: { postMessage },
      teamId: 'T123',
    } as never;

    await handleMessageOrAppMentionEvent({ event, context });

    expect(stopChatSessionTasksMock).toHaveBeenCalledWith({
      provider: 'slack',
      workspaceId: 'T123',
      channelId: 'C123',
      conversationId: '100.000',
      threadId: '100.000',
      userId: 'user-1',
    });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: '100.000',
        text: 'Stopped 2 active tasks. The work remains resumable; send another message here to continue.',
      }),
    );
    expect(fetchThreadMessagesMock).not.toHaveBeenCalled();
    expect(recordInboundSlackConversationMessageMock).not.toHaveBeenCalled();
  }, 15_000);

  it('preserves linked inbound history capture for a suppressed reply', async () => {
    const { recordSuppressedUnmentionedSlackThreadReply } =
      await import('./message-entry.js');
    const event = threadReplyEvent({ user: 'U111', ts: '102.000' });
    const slack = {} as never;

    await recordSuppressedUnmentionedSlackThreadReply({
      event,
      slack,
      teamId: 'T123',
    });

    expect(lookupSlackUserMappingMock).toHaveBeenCalledWith({
      slackUserId: 'U111',
      teamId: 'T123',
    });
    expect(recordInboundSlackConversationMessageMock).toHaveBeenCalledWith({
      event,
      slack,
      userMapping: { userId: 'user-1', slackUserId: 'U111' },
      teamId: 'T123',
      shouldRecordThreadReply: true,
    });
  }, 15_000);

  it('does not create a history record for an unlinked suppressed reply', async () => {
    lookupSlackUserMappingMock.mockResolvedValue({ activeMapping: null });
    const { recordSuppressedUnmentionedSlackThreadReply } =
      await import('./message-entry.js');

    await recordSuppressedUnmentionedSlackThreadReply({
      event: threadReplyEvent({ user: 'U999', ts: '102.000' }),
      slack: {} as never,
      teamId: 'T123',
    });

    expect(recordInboundSlackConversationMessageMock).not.toHaveBeenCalled();
  }, 15_000);

  it('never fetches history or consults the judgment model for an unlinked sender', async () => {
    lookupSlackUserMappingMock.mockResolvedValue({ activeMapping: null });
    getFastAgentSessionOwnerMock.mockResolvedValue({
      kind: 'user',
      userId: 'owner-user-id',
    });
    evaluateTypeSafeJudgmentsMock.mockResolvedValue({
      addressee: {
        type: 'choice',
        choice: 'roomote',
        confidence: 1,
        probabilities: { roomote: 1, participant: 0, unclear: 0 },
      },
      closingAcknowledgement: { type: 'noul', noul: 0.05 },
    });

    await expect(
      routeDecision(
        threadReplyEvent({
          user: 'U999',
          ts: '102.000',
          text: 'roomote what about the Telegram integration?',
        }),
      ),
    ).resolves.toEqual({ shouldRoute: false });
    expect(lookupSlackUserMappingMock).toHaveBeenCalledWith({
      slackUserId: 'U999',
      teamId: 'T123',
    });
    expect(fetchThreadMessagesMock).not.toHaveBeenCalled();
    expect(evaluateTypeSafeJudgmentsMock).not.toHaveBeenCalled();
  }, 15_000);

  it('routes an unmentioned reply in an existing fast-agent thread', async () => {
    getFastAgentSessionOwnerMock.mockResolvedValue({
      kind: 'user',
      userId: 'owner-user-id',
    });
    findRoomoteOwnedSlackThreadMock.mockResolvedValue(null);
    fetchThreadMessagesMock.mockResolvedValue([
      humanMessage('U111', THREAD_TS, '<@UBOT> hi'),
      botMessage('101.000', 'Hi there.'),
    ]);

    await expect(
      routeDecision(
        threadReplyEvent({
          user: 'U111',
          ts: '102.000',
          text: 'How are you?',
        }),
      ),
    ).resolves.toMatchObject({ shouldRoute: true });
    expect(getFastAgentSessionOwnerMock).toHaveBeenCalledWith({
      surface: 'slack',
      workspaceId: 'T123',
      conversationId: THREAD_TS,
      replyTarget: { channelId: 'C123', threadId: THREAD_TS },
    });
    expect(findRoomoteOwnedSlackThreadMock).not.toHaveBeenCalled();
  }, 15_000);

  it('keeps explicit Roomote mentions on the normal Slack entry path', async () => {
    const { handleMessageOrAppMentionEvent } =
      await import('./message-entry.js');

    await handleMessageOrAppMentionEvent({
      event: {
        type: 'app_mention',
        channel: 'C123',
        channel_type: 'channel',
        thread_ts: THREAD_TS,
        user: 'U111',
        ts: '102.000',
        text: '<@UBOT> please continue',
      } as never,
      context: {
        slackInstallation,
        slack: {} as never,
        teamId: 'T123',
      } as never,
    });

    expect(processFastAgentMessageMock).toHaveBeenCalledOnce();
    expect(processFastAgentMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        directedAtRoomote: true,
        event: expect.objectContaining({ text: '<@UBOT> please continue' }),
      }),
    );
    expect(evaluateTypeSafeJudgmentsMock).not.toHaveBeenCalled();
  });

  it('waits for delayed root binding before classifying an automatic reply', async () => {
    const bindingLock = createDeferred<() => Promise<void>>();
    acquireRootBindingLockMock.mockReturnValueOnce(bindingLock.promise);
    getFastAgentSessionOwnerMock.mockResolvedValue({
      kind: 'user',
      userId: 'owner-user-id',
    });
    findRoomoteOwnedSlackThreadMock.mockResolvedValue(null);
    fetchThreadMessagesMock.mockResolvedValue([
      botMessage(THREAD_TS, 'Automation result'),
    ]);

    const decision = routeDecision(
      threadReplyEvent({
        user: 'U111',
        ts: '102.000',
        text: 'Can you follow up?',
      }),
    );

    await vi.waitFor(() => {
      expect(acquireRootBindingLockMock).toHaveBeenCalledWith({
        teamId: 'T123',
        channelId: 'C123',
      });
    });
    expect(getFastAgentSessionOwnerMock).not.toHaveBeenCalled();

    bindingLock.resolve(releaseRootBindingLockMock);
    await expect(decision).resolves.toMatchObject({ shouldRoute: true });
    expect(getFastAgentSessionOwnerMock).toHaveBeenCalledOnce();
  });

  it("routes Matt when he joins Dan's existing fast-agent conversation", async () => {
    getFastAgentSessionOwnerMock.mockResolvedValue({
      kind: 'user',
      userId: 'owner-user-id',
    });
    findRoomoteOwnedSlackThreadMock.mockResolvedValue(null);
    fetchThreadMessagesMock.mockResolvedValue([
      humanMessage('UDAN', THREAD_TS, '<@UBOT> hi'),
      botMessage('101.000', 'Hi Dan.'),
    ]);

    await expect(
      routeDecision(
        threadReplyEvent({
          user: 'UMATT',
          ts: '102.000',
          text: 'Hey Roomote, can you check this too?',
        }),
      ),
    ).resolves.toMatchObject({ shouldRoute: true });
  });

  it('keeps an unmentioned new participant quiet after another human spoke', async () => {
    getFastAgentSessionOwnerMock.mockResolvedValue({
      kind: 'user',
      userId: 'owner-user-id',
    });
    findRoomoteOwnedSlackThreadMock.mockResolvedValue(null);
    fetchThreadMessagesMock.mockResolvedValue([
      humanMessage('U111', THREAD_TS, '<@UBOT> hi'),
      botMessage('101.000', 'Hi there.'),
      humanMessage('U111', '102.000', 'One more detail'),
    ]);

    await expect(
      routeDecision(
        threadReplyEvent({
          user: 'U222',
          ts: '103.000',
          text: 'Can you check that too?',
        }),
      ),
    ).resolves.toEqual({
      shouldRoute: false,
      shouldRecordConversationMessage: true,
    });
    expect(markSlackThreadExplicitMentionRequiredMock).toHaveBeenCalledOnce();
  });

  it('keeps a reply to a peer mention quiet when no judgment model is selected', async () => {
    getFastAgentSessionOwnerMock.mockResolvedValue({
      kind: 'user',
      userId: 'owner-user-id',
    });
    findRoomoteOwnedSlackThreadMock.mockResolvedValue(null);
    fetchThreadMessagesMock.mockResolvedValue([
      humanMessage('U111', THREAD_TS, '<@UBOT> hi'),
      botMessage('101.000', 'Hi there.'),
      humanMessage('U111', '102.000', '<@U222> what do you think?'),
    ]);

    await expect(
      routeDecision(
        threadReplyEvent({
          user: 'U222',
          ts: '103.000',
          text: 'I agree',
        }),
      ),
    ).resolves.toEqual({
      shouldRoute: false,
      shouldRecordConversationMessage: true,
    });
    expect(markSlackThreadExplicitMentionRequiredMock).toHaveBeenCalledOnce();
  });

  it('keeps the peer-mention cutoff in a task thread without a Fast owner', async () => {
    getFastAgentSessionOwnerMock.mockResolvedValue(null);

    await expect(
      routeDecision(
        threadReplyEvent({
          user: 'participant-user-id',
          ts: '102.000',
          text: '<@U333> what do you think?',
        }),
      ),
    ).resolves.toEqual({
      shouldRoute: false,
      shouldRecordConversationMessage: true,
    });
    expect(fetchThreadMessagesMock).not.toHaveBeenCalled();
  });

  it('does not mark an unrelated peer message recordable', async () => {
    getFastAgentSessionOwnerMock.mockResolvedValue(null);
    findRoomoteOwnedSlackThreadMock.mockResolvedValue(null);
    findActiveSlackTaskRunMock.mockResolvedValue(null);
    findCompletedSlackTaskRunWithSnapshotMock.mockResolvedValue(null);

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

  it('keeps routing after the sender mentions themself in a fast-agent thread', async () => {
    getFastAgentSessionOwnerMock.mockResolvedValue({
      kind: 'user',
      userId: 'owner-user-id',
    });
    findRoomoteOwnedSlackThreadMock.mockResolvedValue(null);
    fetchThreadMessagesMock.mockResolvedValue([
      humanMessage('U111', THREAD_TS, '<@UBOT> hi'),
      botMessage('101.000', 'Hi there.'),
      humanMessage('U111', '102.000', '<@U111> note to self'),
    ]);

    await expect(
      routeDecision(
        threadReplyEvent({
          user: 'U111',
          ts: '103.000',
          text: 'One more detail',
        }),
      ),
    ).resolves.toMatchObject({ shouldRoute: true });
    expect(markSlackThreadExplicitMentionRequiredMock).not.toHaveBeenCalled();
  });

  it('keeps a current peer mention quiet when no judgment model is selected', async () => {
    getFastAgentSessionOwnerMock.mockResolvedValue({
      kind: 'user',
      userId: 'owner-user-id',
    });
    findRoomoteOwnedSlackThreadMock.mockResolvedValue(null);
    fetchThreadMessagesMock.mockResolvedValue([
      humanMessage('U111', THREAD_TS, '<@UBOT> hi'),
      botMessage('101.000', 'Hi there.'),
    ]);

    await expect(
      routeDecision(
        threadReplyEvent({
          user: 'U111',
          ts: '102.000',
          text: '<@U333> what do you think?',
        }),
      ),
    ).resolves.toEqual({
      shouldRoute: false,
      shouldRecordConversationMessage: true,
    });
    expect(fetchThreadMessagesMock).toHaveBeenCalledOnce();
    expect(markSlackThreadExplicitMentionRequiredMock).toHaveBeenCalledOnce();
  });

  it('keeps an unmentioned peer exchange quiet until Roomote replies', async () => {
    getFastAgentSessionOwnerMock.mockResolvedValue({
      kind: 'user',
      userId: 'owner-user-id',
    });
    findRoomoteOwnedSlackThreadMock.mockResolvedValue(null);
    const threadMessages = [
      humanMessage('U111', THREAD_TS, '<@UBOT> hi'),
      botMessage('101.000', 'Hi there.'),
    ];
    fetchThreadMessagesMock.mockImplementation(async () => threadMessages);
    const peerExchange = [
      ['U111', '102.000', '<@U222> what do you think?'],
      ['U222', '103.000', 'Not really'],
      ['U111', '104.000', 'I prefer consistency'],
    ] as const;
    for (const [user, ts, text] of peerExchange) {
      await expect(
        routeDecision(threadReplyEvent({ user, ts, text })),
      ).resolves.toEqual({
        shouldRoute: false,
        shouldRecordConversationMessage: true,
      });
      threadMessages.push(humanMessage(user, ts, text));
    }
    expect(evaluateTypeSafeJudgmentsMock).toHaveBeenCalledTimes(3);
    expect(markSlackThreadExplicitMentionRequiredMock).toHaveBeenCalledTimes(3);
    expect(findRoomoteOwnedSlackThreadMock).not.toHaveBeenCalled();
  });

  it('gates an opted-in peer message with the configured judgment model', async () => {
    getFastAgentSessionOwnerMock.mockResolvedValue({
      kind: 'user',
      userId: 'owner-user-id',
    });
    findRoomoteOwnedSlackThreadMock.mockResolvedValue(null);
    fetchThreadMessagesMock.mockResolvedValue([
      humanMessage('U111', THREAD_TS, '<@UBOT> hi'),
      botMessage('101.000', 'Hi there.'),
    ]);
    evaluateTypeSafeJudgmentsMock.mockResolvedValue({
      addressee: {
        type: 'choice',
        choice: 'participant',
        confidence: 0.92,
        probabilities: { roomote: 0.03, participant: 0.92, unclear: 0.05 },
      },
      closingAcknowledgement: { type: 'noul', noul: 0.05 },
    });

    await expect(
      routeDecision(
        threadReplyEvent({
          user: 'U111',
          ts: '102.000',
          text: '<@U222> what do you think?',
        }),
      ),
    ).resolves.toEqual({
      shouldRoute: false,
      shouldRecordConversationMessage: true,
    });
    expect(fetchThreadMessagesMock).toHaveBeenCalledOnce();
    expect(evaluateTypeSafeJudgmentsMock).toHaveBeenCalledOnce();
  });

  it('uses the conservative no-model fallback when another human spoke after Roomote', async () => {
    getFastAgentSessionOwnerMock.mockResolvedValue({
      kind: 'user',
      userId: 'owner-user-id',
    });
    findRoomoteOwnedSlackThreadMock.mockResolvedValue(null);
    fetchThreadMessagesMock.mockResolvedValue([
      humanMessage('U111', THREAD_TS, '<@UBOT> hi'),
      botMessage('101.000', 'Hi there.'),
      humanMessage('U222', '102.000', 'Can you take a look?'),
    ]);

    await expect(
      routeDecision(
        threadReplyEvent({
          user: 'U111',
          ts: '103.000',
          text: 'Sounds good, I will check.',
        }),
      ),
    ).resolves.toEqual({
      shouldRoute: false,
      shouldRecordConversationMessage: true,
    });
    expect(evaluateTypeSafeJudgmentsMock).toHaveBeenCalledOnce();
    expect(markSlackThreadExplicitMentionRequiredMock).toHaveBeenCalledOnce();
  });

  it('reopens the no-model fallback after Roomote replies', async () => {
    getFastAgentSessionOwnerMock.mockResolvedValue({
      kind: 'user',
      userId: 'owner-user-id',
    });
    findRoomoteOwnedSlackThreadMock.mockResolvedValue(null);
    fetchThreadMessagesMock.mockResolvedValue([
      humanMessage('U111', THREAD_TS, '<@UBOT> hi'),
      humanMessage('U222', '101.000', 'What do you think?'),
      botMessage('102.000', 'Hi there.'),
    ]);

    await expect(
      routeDecision(
        threadReplyEvent({
          user: 'U111',
          ts: '103.000',
          text: 'I agree with that',
        }),
      ),
    ).resolves.toMatchObject({ shouldRoute: true });
    expect(evaluateTypeSafeJudgmentsMock).toHaveBeenCalledOnce();
    expect(markSlackThreadExplicitMentionRequiredMock).not.toHaveBeenCalled();
  });

  it('keeps configured judgment-model routing authoritative for peer conversations', async () => {
    getFastAgentSessionOwnerMock.mockResolvedValue({
      kind: 'user',
      userId: 'owner-user-id',
    });
    findRoomoteOwnedSlackThreadMock.mockResolvedValue(null);
    fetchThreadMessagesMock.mockResolvedValue([
      humanMessage('U111', THREAD_TS, '<@UBOT> hi'),
      botMessage('101.000', 'Hi there.'),
      humanMessage('U222', '102.000', 'I think the second option works.'),
    ]);
    evaluateTypeSafeJudgmentsMock.mockResolvedValue({
      addressee: {
        type: 'choice',
        choice: 'roomote',
        confidence: 0.82,
        probabilities: { roomote: 0.82, participant: 0.1, unclear: 0.08 },
      },
      closingAcknowledgement: { type: 'noul', noul: 0.05 },
    });

    await expect(
      routeDecision(
        threadReplyEvent({
          user: 'U111',
          ts: '103.000',
          text: 'Roomote, could you put that into a short plan?',
        }),
      ),
    ).resolves.toMatchObject({
      shouldRoute: true,
      addressedToRoomote: true,
    });
    expect(evaluateTypeSafeJudgmentsMock).toHaveBeenCalledOnce();
    expect(markSlackThreadExplicitMentionRequiredMock).not.toHaveBeenCalled();
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

  it('routes an unmentioned reply in an active task thread missing conversation ownership', async () => {
    findRoomoteOwnedSlackThreadMock.mockResolvedValue(null);
    findActiveSlackTaskRunMock.mockResolvedValue({ id: 41 });
    fetchThreadMessagesMock.mockResolvedValue([
      humanMessage('U111', THREAD_TS, '<@UBOT> please fix the bug'),
      botMessage('101.000'),
    ]);

    await expect(
      routeDecision(threadReplyEvent({ user: 'U111', ts: '102.000' })),
    ).resolves.toMatchObject({ shouldRoute: true });
    expect(findCompletedSlackTaskRunWithSnapshotMock).not.toHaveBeenCalled();
  });

  it('routes an unmentioned reply in a resumable task thread missing conversation ownership', async () => {
    findRoomoteOwnedSlackThreadMock.mockResolvedValue(null);
    findCompletedSlackTaskRunWithSnapshotMock.mockResolvedValue({
      id: 42,
      snapshotId: 'snapshot-1',
    });
    fetchThreadMessagesMock.mockResolvedValue([
      humanMessage('U111', THREAD_TS, '<@UBOT> please fix the bug'),
      botMessage('101.000'),
    ]);

    await expect(
      routeDecision(threadReplyEvent({ user: 'U111', ts: '102.000' })),
    ).resolves.toMatchObject({ shouldRoute: true });
    expect(findActiveSlackTaskRunMock).toHaveBeenCalledWith(THREAD_TS, {
      slackTeamId: 'T123',
    });
    expect(findCompletedSlackTaskRunWithSnapshotMock).toHaveBeenCalledWith(
      THREAD_TS,
      { slackTeamId: 'T123' },
    );
  });

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
    ).resolves.toMatchObject({ shouldRoute: false });
    expect(markSlackThreadExplicitMentionRequiredMock).toHaveBeenCalledWith(
      'C123',
      THREAD_TS,
    );
  });

  it('routes an interjected reply the judgment model confidently gives to Roomote', async () => {
    evaluateTypeSafeJudgmentsMock.mockResolvedValue({
      addressee: {
        type: 'choice',
        choice: 'roomote',
        confidence: 0.95,
        probabilities: { roomote: 0.95, participant: 0.03, unclear: 0.02 },
      },
      closingAcknowledgement: { type: 'noul', noul: 0.05 },
    });
    fetchThreadMessagesMock.mockResolvedValue([
      humanMessage('U111', THREAD_TS, '<@UBOT> please fix the bug'),
      botMessage('101.000', 'I opened a PR with the fix.'),
      humanMessage('U222', '102.000', 'nice, looks good'),
    ]);

    await expect(
      routeDecision(
        threadReplyEvent({
          user: 'U111',
          ts: '103.000',
          text: 'can you also add a unit test?',
        }),
      ),
    ).resolves.toMatchObject({
      shouldRoute: true,
      addressedToRoomote: true,
    });
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
    expect(markSlackThreadExplicitMentionRequiredMock).not.toHaveBeenCalled();
  });

  it('requires a mention when somebody else was mentioned since the bot last spoke', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanMessage('U111', THREAD_TS, '<@UBOT> please fix the bug'),
      botMessage('101.000'),
      humanMessage('U111', '102.000', 'cc <@U333> for visibility'),
    ]);

    await expect(
      routeDecision(threadReplyEvent({ user: 'U111', ts: '103.000' })),
    ).resolves.toMatchObject({ shouldRoute: false });
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
    ).resolves.toMatchObject({ shouldRoute: false });
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

  it('carries the source task binding for a tracked automation report alias', async () => {
    findRoomoteOwnedSlackThreadMock.mockResolvedValue({
      taskId: 'task-source',
      trackedAliasTaskId: 'task-source',
      userId: 'user-4',
      slackUserId: null,
      isAutomationReportThread: true,
    });
    fetchThreadMessagesMock.mockResolvedValue([
      botMessage(THREAD_TS, 'Platform issue reported'),
    ]);

    await expect(
      routeDecision(threadReplyEvent({ user: 'U444', ts: '102.000' })),
    ).resolves.toMatchObject({
      shouldRoute: true,
      taskId: 'task-source',
    });
  });

  it('does not pin custom automation fallback threads to an arbitrary task', async () => {
    findRoomoteOwnedSlackThreadMock.mockResolvedValue({
      taskId: 'task-from-unordered-fallback',
      trackedAliasTaskId: null,
      userId: null,
      slackUserId: null,
      isAutomationReportThread: true,
    });
    fetchThreadMessagesMock.mockResolvedValue([
      botMessage(THREAD_TS, 'Custom automation report'),
    ]);

    await expect(
      routeDecision(threadReplyEvent({ user: 'U444', ts: '102.000' })),
    ).resolves.toEqual(
      expect.not.objectContaining({ taskId: 'task-from-unordered-fallback' }),
    );
  });

  it('resolves the same alert alias when the reply explicitly mentions Roomote', async () => {
    findRoomoteOwnedSlackThreadMock.mockResolvedValue({
      taskId: 'task-source',
      trackedAliasTaskId: 'task-source',
      userId: 'user-4',
      slackUserId: null,
      isAutomationReportThread: true,
    });
    const { resolveMentionedSlackThreadAliasTaskId } =
      await import('./message-entry.js');

    await expect(
      resolveMentionedSlackThreadAliasTaskId({
        event: threadReplyEvent({
          user: 'U444',
          text: '<@UBOT> please continue',
          ts: '102.000',
        }),
        botUserId: 'UBOT',
        teamId: 'T123',
      }),
    ).resolves.toBe('task-source');
  });

  it('treats the whole thread as the window when no bot message is found in history', async () => {
    fetchThreadMessagesMock.mockResolvedValue([
      humanMessage('U111', THREAD_TS, '<@UBOT> please fix the bug'),
      humanMessage('U222', '101.000', 'interesting thread'),
    ]);

    await expect(
      routeDecision(threadReplyEvent({ user: 'U111', ts: '102.000' })),
    ).resolves.toMatchObject({ shouldRoute: false });
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
    ).resolves.toMatchObject({ shouldRoute: false });
    expect(fetchThreadMessagesMock).not.toHaveBeenCalled();
    expect(evaluateTypeSafeJudgmentsMock).not.toHaveBeenCalled();
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
    ).resolves.toMatchObject({ shouldRoute: false });
    expect(fetchThreadMessagesMock).not.toHaveBeenCalled();
  });

  it('requires a mention when thread history comes back empty (failed fetch)', async () => {
    fetchThreadMessagesMock.mockResolvedValue([]);

    await expect(
      routeDecision(threadReplyEvent({ user: 'U111', ts: '102.000' })),
    ).resolves.toMatchObject({ shouldRoute: false });
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
    ).resolves.toMatchObject({ shouldRoute: false });
    expect(fetchThreadMessagesMock).not.toHaveBeenCalled();
    expect(findActiveSlackTaskRunMock).toHaveBeenCalledWith(THREAD_TS, {
      slackTeamId: 'T123',
    });
    expect(findCompletedSlackTaskRunWithSnapshotMock).toHaveBeenCalledWith(
      THREAD_TS,
      { slackTeamId: 'T123' },
    );
  });
});
