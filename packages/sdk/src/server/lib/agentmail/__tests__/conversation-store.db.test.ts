import { randomUUID } from 'node:crypto';

import {
  agentmailConversationParticipants,
  agentmailConversations,
  agentmailUserMappings,
  db,
  eq,
  userFactory,
} from '@roomote/db/server';

import {
  advanceAgentMailInboundAnchor,
  recordAgentMailOutboundMessage,
  resolveOrCreateAgentMailConversation,
} from '../conversation-store';

const INBOX = 'roomote-test@agentmail.to';

async function mappedUser() {
  const user = await userFactory.create();
  const email = `${randomUUID()}@example.com`;
  await db.insert(agentmailUserMappings).values({
    emailAddress: email,
    userId: user.id,
    source: 'link_code',
  });
  return { user, email };
}

describe('agentmail conversation store (real database)', () => {
  it('creates a conversation with the sender as owner on first contact and reuses it after', async () => {
    const { user } = await mappedUser();
    const threadId = `thread-${randomUUID()}`;

    const first = await resolveOrCreateAgentMailConversation({
      inboxId: INBOX,
      providerThreadId: threadId,
      senderUserId: user.id,
      subject: 'Hello',
      recipientAddresses: [],
    });
    expect(first.created).toBe(true);
    expect(first.conversation.ownerUserId).toBe(user.id);

    const second = await resolveOrCreateAgentMailConversation({
      inboxId: INBOX,
      providerThreadId: threadId,
      senderUserId: user.id,
      subject: 'Hello',
      recipientAddresses: [],
    });
    expect(second.created).toBe(false);
    expect(second.conversation.id).toBe(first.conversation.id);
  });

  it('forks a forwarded thread into an isolated conversation for a non-participant', async () => {
    const { user: owner } = await mappedUser();
    const { user: forwarder } = await mappedUser();
    const threadId = `thread-${randomUUID()}`;

    const original = await resolveOrCreateAgentMailConversation({
      inboxId: INBOX,
      providerThreadId: threadId,
      senderUserId: owner.id,
      subject: 'Original',
      recipientAddresses: [],
    });

    const fork = await resolveOrCreateAgentMailConversation({
      inboxId: INBOX,
      providerThreadId: threadId,
      senderUserId: forwarder.id,
      subject: 'Fwd: Original',
      recipientAddresses: [],
    });

    expect(fork.created).toBe(true);
    expect(fork.conversation.id).not.toBe(original.conversation.id);
    expect(fork.conversation.providerThreadId).toBe(threadId);
    expect(fork.conversation.ownerUserId).toBe(forwarder.id);
  });

  it('joins the single candidate conversation when the inbound to/cc identities intersect it', async () => {
    const { user: owner, email: ownerEmail } = await mappedUser();
    const { user: ccUser } = await mappedUser();
    const threadId = `thread-${randomUUID()}`;

    const original = await resolveOrCreateAgentMailConversation({
      inboxId: INBOX,
      providerThreadId: threadId,
      senderUserId: owner.id,
      subject: 'Original',
      recipientAddresses: [],
    });

    const joined = await resolveOrCreateAgentMailConversation({
      inboxId: INBOX,
      providerThreadId: threadId,
      senderUserId: ccUser.id,
      subject: 'Re: Original',
      recipientAddresses: [ownerEmail, INBOX],
    });

    expect(joined.created).toBe(false);
    expect(joined.joinedAsCc).toBe(true);
    expect(joined.conversation.id).toBe(original.conversation.id);

    const membership =
      await db.query.agentmailConversationParticipants.findFirst({
        where: eq(agentmailConversationParticipants.userId, ccUser.id),
      });
    expect(membership?.role).toBe('participant');
    expect(membership?.source).toBe('cc');
  });

  it('never creates two conversations for one sender racing on first contact', async () => {
    const { user } = await mappedUser();
    const threadId = `thread-${randomUUID()}`;

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        resolveOrCreateAgentMailConversation({
          inboxId: INBOX,
          providerThreadId: threadId,
          senderUserId: user.id,
          subject: 'Race',
          recipientAddresses: [],
        }),
      ),
    );

    const ids = new Set(results.map((result) => result.conversation.id));
    expect(ids.size).toBe(1);
  });

  it('advances the inbound anchor by (timestamp, message id) and never regresses it', async () => {
    const { user, email } = await mappedUser();
    const threadId = `thread-${randomUUID()}`;
    const { conversation } = await resolveOrCreateAgentMailConversation({
      inboxId: INBOX,
      providerThreadId: threadId,
      senderUserId: user.id,
      subject: 'Anchors',
      recipientAddresses: [],
    });

    const t1 = new Date('2026-08-31T10:00:00Z');
    const t2 = new Date('2026-08-31T10:00:05Z');

    expect(
      await advanceAgentMailInboundAnchor({
        conversationId: conversation.id,
        messageId: 'msg-b',
        providerTimestamp: t2,
        senderEmail: email,
        senderUserId: user.id,
      }),
    ).toBe(true);

    // An out-of-order older delivery must not regress the anchor.
    expect(
      await advanceAgentMailInboundAnchor({
        conversationId: conversation.id,
        messageId: 'msg-a',
        providerTimestamp: t1,
        senderEmail: email,
        senderUserId: user.id,
      }),
    ).toBe(false);

    // Same timestamp: the message id breaks the tie deterministically.
    expect(
      await advanceAgentMailInboundAnchor({
        conversationId: conversation.id,
        messageId: 'msg-c',
        providerTimestamp: t2,
        senderEmail: email,
        senderUserId: user.id,
      }),
    ).toBe(true);

    // Outbound completion touches only the outbound anchor.
    await recordAgentMailOutboundMessage({
      conversationId: conversation.id,
      messageId: 'out-1',
    });

    const row = await db.query.agentmailConversations.findFirst({
      where: eq(agentmailConversations.id, conversation.id),
    });
    expect(row?.latestInboundMessageId).toBe('msg-c');
    expect(row?.latestOutboundMessageId).toBe('out-1');
  });
});
