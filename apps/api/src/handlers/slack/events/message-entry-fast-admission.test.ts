import {
  asc,
  db,
  eq,
  fastAgentConversations,
  fastAgentParentEvents,
  sessions,
  slackConversationMessages,
  slackUserMappings,
  userFactory,
  users,
} from '@roomote/db/server';
import type { SlackEvent, SlackNotifier } from '@roomote/slack';

const mocks = vi.hoisted(() => ({
  acquireLock: vi.fn(),
  queueAdd: vi.fn(),
  answer: vi.fn(),
  history: vi.fn(),
}));

vi.mock('@roomote/cloud-agents/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/cloud-agents/server')>()),
  acquireFastAgentTurnLock: mocks.acquireLock,
  answerFastAgentQuestion: mocks.answer,
}));
// BullMQ belongs to the SDK, not the API; target its installed dependency.
vi.mock('../../../../../../packages/sdk/node_modules/bullmq', () => ({
  Queue: class {
    add = mocks.queueAdd;
  },
}));
vi.mock('@roomote/redis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/redis')>()),
  getRedis: () => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
    sismember: vi.fn(async () => 0),
    sadd: vi.fn(async () => 1),
    del: vi.fn(async () => 1),
  }),
}));
vi.mock('@roomote/slack', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/slack')>()),
  acquireSlackFastRootBindingLock: vi.fn(async () => async () => {}),
  resolveSlackReactionNames: vi.fn(async () => ({ ackEmoji: 'eyes' })),
  getSlackThreadReplyFooterMessageTs: vi.fn(async () => null),
  createFastAgentSlackLiveTaskLauncher: vi.fn(() => vi.fn()),
}));
vi.mock('@roomote/communication', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/communication')>()),
  resolveFastSessionReplyFooterContext: vi.fn(async () => ({
    linkedPrs: [],
    livePreviewUrl: null,
  })),
}));

import { handleMessageOrAppMentionEvent } from './message-entry.js';

describe('Slack entry to durable Fast admission', () => {
  let userId: string;
  let teamId: string;
  let sessionId: string;
  const threadId = '100.000';
  const channelId = 'C_ADMISSION';
  const slack = {
    fetchThreadMessages: mocks.history,
    normalizeIncomingText: vi.fn(async (text: string) => text),
    addReaction: vi.fn(async () => true),
    removeReaction: vi.fn(async () => true),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.acquireLock.mockResolvedValue(null);
    mocks.queueAdd.mockResolvedValue(undefined);
    const user = await userFactory.create();
    userId = user.id;
    teamId = `T_${user.id}`;
    await db.insert(slackUserMappings).values({
      slackTeamId: teamId,
      slackUserId: 'U_LINKED',
      userId,
    });
    // A delayed root aliases a different canonical conversation identity.
    const [session] = await db
      .insert(fastAgentConversations)
      .values({
        userId,
        surface: 'slack',
        workspaceId: teamId,
        conversationId: `canonical-${userId}`,
        currentReplyChannelId: channelId,
        currentReplyThreadId: threadId,
        replyTargetVerified: true,
      })
      .returning();
    sessionId = session!.id;
    mocks.history.mockResolvedValue([
      { user: 'U_LINKED', ts: threadId, text: '<@UBOT> check with <@U_PEER>' },
    ]);
  });

  afterEach(async () => {
    await db.delete(sessions).where(eq(sessions.fastConversationId, sessionId));
    await db
      .delete(slackConversationMessages)
      .where(eq(slackConversationMessages.slackTeamId, teamId));
    await db
      .delete(fastAgentConversations)
      .where(eq(fastAgentConversations.id, sessionId));
    await db
      .delete(slackUserMappings)
      .where(eq(slackUserMappings.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  });

  async function send(overrides: Partial<SlackEvent> = {}) {
    await handleMessageOrAppMentionEvent({
      event: {
        type: 'message',
        channel: channelId,
        channel_type: 'channel',
        user: 'U_LINKED',
        thread_ts: threadId,
        ts: '102.000',
        text: 'Also check the tests',
        ...overrides,
      } as SlackEvent,
      context: {
        teamId,
        slack: slack as unknown as SlackNotifier,
        slackInstallation: {
          teamId,
          botUserId: 'UBOT',
          appId: 'A_ROOMOTE',
        } as never,
      },
    });
  }

  async function rows() {
    return db.query.fastAgentParentEvents.findMany({
      where: eq(fastAgentParentEvents.conversationId, sessionId),
      orderBy: [
        asc(fastAgentParentEvents.createdAt),
        asc(fastAgentParentEvents.id),
      ],
    });
  }

  it('admits busy follow-ups to the canonical Session, wakes the queue, and deduplicates retries in arrival order', async () => {
    await send();
    await vi.waitFor(() => expect(mocks.queueAdd).toHaveBeenCalledTimes(1));
    await send({ ts: '103.000', text: '<@U_PEER> another detail' });
    await vi.waitFor(() => expect(mocks.queueAdd).toHaveBeenCalledTimes(2));
    await send();
    await vi.waitFor(() => expect(mocks.queueAdd).toHaveBeenCalledTimes(3));

    const admitted = await rows();
    expect(admitted).toHaveLength(2);
    expect(
      await db.query.fastAgentConversations.findMany({
        where: eq(fastAgentConversations.workspaceId, teamId),
        columns: { id: true },
      }),
    ).toEqual([{ id: sessionId }]);
    expect(admitted.map((row) => row.event)).toEqual([
      expect.objectContaining({
        eventId: '102.000',
        question: 'Also check the tests',
        userId,
        directedAtRoomote: false,
      }),
      expect.objectContaining({
        eventId: '103.000',
        question: '<@U_PEER> another detail',
        userId,
        directedAtRoomote: false,
      }),
    ]);
    for (const row of admitted) {
      expect(row).toMatchObject({
        conversationId: sessionId,
        admission: null,
        deliveredAt: null,
        discardedAt: null,
        parent: {
          sessionId,
          conversation: { conversationId: `canonical-${userId}` },
        },
      });
      expect(mocks.queueAdd).toHaveBeenCalledWith(
        'deliver',
        {
          conversationId: sessionId,
          eventKey: row.eventKey,
        },
        { jobId: row.eventKey },
      );
    }
    expect(mocks.acquireLock).toHaveBeenCalledWith({
      conversation: expect.objectContaining({
        conversationId: `canonical-${userId}`,
      }),
      maxWaitMs: 0,
    });
    expect(mocks.answer).not.toHaveBeenCalled();
    expect(slack.addReaction).not.toHaveBeenCalled();
    expect(slack.removeReaction).not.toHaveBeenCalled();
  });

  it('admits a busy bound reply when Slack history is unavailable', async () => {
    mocks.history.mockResolvedValue([]);
    await send();
    await vi.waitFor(() => expect(mocks.queueAdd).toHaveBeenCalledTimes(1));
    expect(await rows()).toEqual([
      expect.objectContaining({
        conversationId: sessionId,
        event: expect.objectContaining({ question: 'Also check the tests' }),
      }),
    ]);
  });

  it.each(['unlinked', 'deleted'])(
    'does not admit an %s sender in a bound Session',
    async (kind) => {
      if (kind === 'deleted') {
        await db
          .update(users)
          .set({ deletedAt: new Date() })
          .where(eq(users.id, userId));
      }
      await send({ user: kind === 'unlinked' ? 'U_UNLINKED' : 'U_LINKED' });
      expect(await rows()).toEqual([]);
      expect(mocks.acquireLock).not.toHaveBeenCalled();
      expect(mocks.queueAdd).not.toHaveBeenCalled();
    },
  );

  it('ignores the bot-mentioned message twin and admits its app_mention once', async () => {
    await send({ text: '<@UBOT> continue' });
    expect(mocks.acquireLock).not.toHaveBeenCalled();
    await send({ type: 'app_mention', text: '<@UBOT> continue' });
    await vi.waitFor(() => expect(mocks.queueAdd).toHaveBeenCalledTimes(1));
    expect(await rows()).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({ directedAtRoomote: true }),
      }),
    ]);
  });
});
