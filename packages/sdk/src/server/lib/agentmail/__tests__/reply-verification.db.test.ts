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
});
