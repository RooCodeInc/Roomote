import { randomUUID } from 'node:crypto';

import {
  agentmailConversationParticipants,
  agentmailConversations,
  agentmailReplyVerificationProofs,
  authUsers,
  db,
  eq,
  userFactory,
  users,
} from '@roomote/db/server';

import {
  buildAgentMailReplyVerificationFooter,
  consumeAgentMailReplyVerification,
} from '../reply-verification';

const INBOX = 'roomote-reply-verification-test@agentmail.to';

async function createUnverifiedUser() {
  const email = `${randomUUID()}@example.com`;
  const user = await userFactory.create({ email });
  await db.insert(authUsers).values({
    id: user.id,
    name: user.name ?? 'Test User',
    email,
    emailVerified: false,
  });
  return { user, email: email.toLowerCase() };
}

async function createOutboundThread(userId: string) {
  const providerThreadId = `thread-${randomUUID()}`;
  const [conversation] = await db
    .insert(agentmailConversations)
    .values({
      inboxId: INBOX,
      providerThreadId,
      ownerUserId: userId,
      subject: 'Roomote notification',
    })
    .returning();
  await db.insert(agentmailConversationParticipants).values({
    conversationId: conversation!.id,
    inboxId: INBOX,
    providerThreadId,
    userId,
    role: 'owner',
    source: 'outbound',
  });
  return providerThreadId;
}

/** A reply message whose plain text quotes the outbound proof footer. */
function replyMessage(token: string) {
  return {
    message_id: `m-${randomUUID()}`,
    thread_id: 'unused-here',
    inbox_id: INBOX,
    from: 'sender',
    timestamp: new Date().toISOString(),
    text: `Sounds good.\n\nOn Tue, Roomote wrote:\n(reference: ${token})`,
  };
}

async function extractToken(
  userId: string,
  emailAddress: string,
): Promise<string> {
  const footer = await buildAgentMailReplyVerificationFooter({
    userId,
    emailAddress,
  });
  const token = footer?.textFooter.match(/rvk_[A-Za-z0-9_-]{32}/)?.[0];
  if (!token) throw new Error('expected a live proof token');
  return token;
}

describe('consumeAgentMailReplyVerification (real database)', () => {
  it('verifies and returns the user id when every gate passes', async () => {
    const { user, email } = await createUnverifiedUser();
    const providerThreadId = await createOutboundThread(user.id);
    const token = await extractToken(user.id, email);

    await expect(
      consumeAgentMailReplyVerification({
        inboxId: INBOX,
        providerThreadId,
        senderEmail: email,
        message: replyMessage(token),
      }),
    ).resolves.toBe(user.id);

    const authUser = await db.query.authUsers.findFirst({
      where: eq(authUsers.id, user.id),
      columns: { emailVerified: true },
    });
    expect(authUser?.emailVerified).toBe(true);
  });

  // Regression for the review finding: the active-member and participant
  // checks are re-verified INSIDE the consumption transaction, so revocation
  // before (or racing) that transaction invalidates the proof instead of
  // verifying a revoked account.
  it.each([
    {
      kind: 'membership revoked',
      revoke: async (userId: string) => {
        await db
          .update(users)
          .set({ deletedAt: new Date() })
          .where(eq(users.id, userId));
      },
    },
    {
      kind: 'participation removed',
      revoke: async (userId: string) => {
        await db
          .delete(agentmailConversationParticipants)
          .where(eq(agentmailConversationParticipants.userId, userId));
      },
    },
  ])('does not verify when $kind has been removed', async ({ revoke }) => {
    const { user, email } = await createUnverifiedUser();
    const providerThreadId = await createOutboundThread(user.id);
    const token = await extractToken(user.id, email);
    await revoke(user.id);

    await expect(
      consumeAgentMailReplyVerification({
        inboxId: INBOX,
        providerThreadId,
        senderEmail: email,
        message: replyMessage(token),
      }),
    ).resolves.toBeNull();

    const authUser = await db.query.authUsers.findFirst({
      where: eq(authUsers.id, user.id),
      columns: { emailVerified: true },
    });
    expect(authUser?.emailVerified).toBe(false);
    const proof = await db.query.agentmailReplyVerificationProofs.findFirst({
      where: eq(agentmailReplyVerificationProofs.userId, user.id),
    });
    expect(proof?.consumedAt).toBeNull();
  });

  // Race regression: a revocation IN FLIGHT while consumption runs must still
  // invalidate the proof. The consumption transaction locks the membership
  // and participant rows FOR UPDATE, so a concurrent revocation either
  // commits first (the locked read then sees it) or blocks behind the lock
  // until consumption finishes — never slips in between the read and the
  // verification write.
  it.each([
    {
      kind: 'membership revocation',
      revoke: (tx: typeof db, userId: string) =>
        tx
          .update(users)
          .set({ deletedAt: new Date() })
          .where(eq(users.id, userId)),
    },
    {
      kind: 'participation removal',
      revoke: (tx: typeof db, userId: string) =>
        tx
          .delete(agentmailConversationParticipants)
          .where(eq(agentmailConversationParticipants.userId, userId)),
    },
  ])(
    'does not verify when $kind commits while consumption waits on its row lock',
    async ({ revoke }) => {
      const { user, email } = await createUnverifiedUser();
      const providerThreadId = await createOutboundThread(user.id);
      const token = await extractToken(user.id, email);

      let revocationApplied = false;
      let releaseHold!: () => void;
      const hold = new Promise<void>((resolve) => {
        releaseHold = resolve;
      });
      // Revocation runs in its own transaction: it takes the row lock with
      // its write, proves it is in flight, then holds the lock open while
      // consumption starts (and blocks on the same row), then commits.
      const revocation = db.transaction(async (tx) => {
        await revoke(tx as unknown as typeof db, user.id);
        revocationApplied = true;
        await hold;
      });
      await vi.waitFor(() => {
        expect(revocationApplied).toBe(true);
      });

      const consumption = consumeAgentMailReplyVerification({
        inboxId: INBOX,
        providerThreadId,
        senderEmail: email,
        message: replyMessage(token),
      });
      releaseHold();
      const [result] = await Promise.all([consumption, revocation]);

      expect(result).toBeNull();
      const authUser = await db.query.authUsers.findFirst({
        where: eq(authUsers.id, user.id),
        columns: { emailVerified: true },
      });
      expect(authUser?.emailVerified).toBe(false);
      const proof = await db.query.agentmailReplyVerificationProofs.findFirst({
        where: eq(agentmailReplyVerificationProofs.userId, user.id),
      });
      expect(proof?.consumedAt).toBeNull();
    },
  );
});
