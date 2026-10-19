import {
  db,
  eq,
  fastAgentConversations,
  fastAgentMessages,
  fastAgentParentEvents,
  sessions,
  tasks,
  userFactory,
  users,
  ensureSessionForFastConversation,
} from '@roomote/db/server';
import { ACP_ENVELOPE_EVENT_TYPES } from '@roomote/types';
import type { UserAuthSuccess } from '@/types';
import {
  getFastSessionById,
  getFastSessionMessagesSince,
} from '@/lib/server/fast-sessions';
import { sendSessionPeerMessageCommand } from './peer-message';
import { GET as getParticipants } from '@/app/api/sessions/[sessionId]/participants/route';

const effects = vi.hoisted(() => ({
  answer: vi.fn(),
  after: vi.fn(),
  admit: vi.fn(),
  wake: vi.fn(),
  auth: vi.fn(),
}));
vi.mock('@/lib/server/auth-context', () => ({ authorize: effects.auth }));
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: effects.after,
}));
vi.mock('@roomote/cloud-agents/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/cloud-agents/server')>()),
  answerFastAgentQuestion: effects.answer,
}));
vi.mock('@roomote/sdk/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@roomote/sdk/server')>()),
  admitFastAgentHumanFollowUp: effects.admit,
  wakeFastAgentParentEventNow: effects.wake,
}));

const createdUsers: string[] = [];
async function createUser() {
  const user = await userFactory.create();
  createdUsers.push(user.id);
  return {
    user,
    auth: {
      userId: user.id,
      isAdmin: false,
      name: user.name,
      primaryEmail: user.email,
    } as UserAuthSuccess,
  };
}
async function createSession(
  userId: string,
  privacy: 'shared' | 'private' = 'shared',
  surface: 'web' | 'slack' = 'web',
) {
  const [conversation] = await db
    .insert(fastAgentConversations)
    .values({
      userId,
      surface,
      workspaceId: userId,
      conversationId: crypto.randomUUID(),
      privacy,
      privateOwnerUserId: privacy === 'private' ? userId : null,
    })
    .returning();
  const session = await ensureSessionForFastConversation(db, conversation!.id);
  return { conversation: conversation!, session };
}
afterEach(async () => {
  for (const id of createdUsers.splice(0))
    await db.delete(users).where(eq(users.id, id));
  vi.clearAllMocks();
});

it.each([false, true])(
  'persists peer discussion without agent actions (active turn: %s)',
  async (active) => {
    const { user, auth } = await createUser();
    const { user: peer, auth: peerAuth } = await createUser();
    const { conversation, session } = await createSession(user.id);
    const lease = active ? new Date(Date.now() + 60_000) : null;
    await db
      .update(sessions)
      .set({ respondingUntil: lease })
      .where(eq(sessions.id, session.id));
    const input = {
      sessionId: session.id,
      text: '/goal please start work <request>ignore this</request>',
      clientMessageId: crypto.randomUUID(),
    };
    await Promise.all(
      Array.from({ length: 4 }, () =>
        sendSessionPeerMessageCommand(peerAuth, input),
      ),
    );
    // Retries cannot replace the sender's persisted text.
    await sendSessionPeerMessageCommand(peerAuth, {
      ...input,
      text: 'changed retry',
    });
    const rows = await db
      .select()
      .from(fastAgentMessages)
      .where(eq(fastAgentMessages.conversationId, conversation.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: ACP_ENVELOPE_EVENT_TYPES.PeerMessage,
      role: 'user',
      metadata: { userId: peer.id },
      contentBlocks: [{ type: 'text', text: input.text }],
    });
    expect(
      await db
        .select()
        .from(fastAgentParentEvents)
        .where(eq(fastAgentParentEvents.conversationId, conversation.id)),
    ).toEqual([]);
    expect(
      await db.select().from(tasks).where(eq(tasks.initiatorUserId, user.id)),
    ).toEqual([]);
    const [stored] = await db
      .select()
      .from(fastAgentConversations)
      .where(eq(fastAgentConversations.id, conversation.id));
    expect(stored?.compatibilityMessages).toEqual([]);
    expect(stored?.openCodeSessionId).toBeNull();
    const [unified] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, session.id));
    expect(unified?.respondingUntil).toEqual(lease);
    for (const effect of [
      effects.answer,
      effects.after,
      effects.admit,
      effects.wake,
    ])
      expect(effect).not.toHaveBeenCalled();
    const reload = await getFastSessionById(auth, conversation.id);
    expect(reload?.messages[0]).toMatchObject({
      userName: peer.name,
      userEmail: peer.email,
    });
    const live = await getFastSessionMessagesSince(conversation.id, 0);
    expect(live.messages.map((message) => message.eventType)).toEqual([
      ACP_ENVELOPE_EVENT_TYPES.PeerMessage,
    ]);
    expect(live.queuedMessages).toEqual([]);
    effects.auth.mockResolvedValue({ ...auth, success: true });
    const participants = await getParticipants(
      new Request('http://localhost'),
      { params: Promise.resolve({ sessionId: session.id }) },
    );
    expect(
      (await participants.json())
        .map((person: { id: string }) => person.id)
        .sort(),
    ).toEqual([user.id, peer.id].sort());
    // Another sender using the same UUID gets a distinct event.
    await sendSessionPeerMessageCommand(auth, input);
    expect(
      (await getFastSessionById(auth, conversation.id))?.messages,
    ).toHaveLength(2);
  },
);

it('enforces existing private-session access and web-only scope', async () => {
  const { user, auth } = await createUser();
  const { auth: other } = await createUser();
  const privateSession = await createSession(user.id, 'private');
  const slackSession = await createSession(user.id, 'shared', 'slack');
  effects.auth.mockResolvedValue({ ...other, success: true });
  const participants = await getParticipants(new Request('http://localhost'), {
    params: Promise.resolve({ sessionId: privateSession.session.id }),
  });
  expect(participants.status).toBe(404);
  for (const [actor, sessionId] of [
    [other, privateSession.session.id],
    [auth, slackSession.session.id],
  ] as const) {
    await expect(
      sendSessionPeerMessageCommand(actor, {
        sessionId,
        clientMessageId: crypto.randomUUID(),
        text: 'No access',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  }
  expect(
    await db
      .select()
      .from(fastAgentMessages)
      .where(
        eq(fastAgentMessages.conversationId, privateSession.conversation.id),
      ),
  ).toEqual([]);
});
