import { randomUUID } from 'node:crypto';

const mocks = vi.hoisted(() => ({
  continueWithLock: vi.fn(),
}));

vi.mock('../../fast-agent-surface-reply', () => ({
  continueFastAgentSurfaceReplyWithLock: mocks.continueWithLock,
}));

import {
  agentmailConversations,
  agentmailInboundTurns,
  agentmailSuppressions,
  agentmailWebhookEvents,
  asc,
  authUsers,
  db,
  eq,
  userFactory,
} from '@roomote/db/server';
import { getRedis } from '@roomote/redis';

import {
  drainAgentMailInboundTurns,
  processAgentMailWebhookEvent,
  recordAgentMailWebhookEvent,
  recoverPendingAgentMailWork,
} from '../inbound';
import { isAgentMailAddressSuppressed } from '../outbound';

const INBOX = 'roomote-test@agentmail.to';

function messageReceivedPayload(input: {
  eventId: string;
  threadId: string;
  messageId: string;
  from: string;
  text: string;
  timestamp?: string;
}) {
  return {
    type: 'event',
    event_type: 'message.received',
    event_id: input.eventId,
    message: {
      message_id: input.messageId,
      thread_id: input.threadId,
      inbox_id: INBOX,
      from: input.from,
      to: [INBOX],
      subject: 'Test request',
      text: input.text,
      extracted_text: input.text,
      timestamp: input.timestamp ?? new Date().toISOString(),
    },
    thread: {
      thread_id: input.threadId,
      last_message_id: input.messageId,
      message_count: 1,
    },
  };
}

// Senders are recognized only by a verified account email.
async function createVerifiedSender() {
  const senderEmail = `${randomUUID()}@example.com`;
  const user = await userFactory.create({ email: senderEmail });
  await db.insert(authUsers).values({
    id: user.id,
    name: user.name ?? 'Test User',
    email: senderEmail,
    emailVerified: true,
  });
  return { user, senderEmail };
}

describe('agentmail webhook event outbox (real database)', () => {
  beforeAll(() => {
    process.env.R_EMAIL_CHANNEL_ENABLED = 'true';
    process.env.R_AGENTMAIL_API_KEY = 'am_test_key';
    process.env.R_AGENTMAIL_WEBHOOK_SECRET = 'whsec_dGVzdA==';
    process.env.R_AGENTMAIL_INBOX_ID = INBOX;
  });

  it('acknowledges and drops deliveries while the email channel is disabled', async () => {
    process.env.R_EMAIL_CHANNEL_ENABLED = 'false';
    try {
      const deliveryId = `msg_${randomUUID()}`;
      const result = await recordAgentMailWebhookEvent({
        deliveryId,
        eventId: null,
        eventType: 'message.received',
        payload: messageReceivedPayload({
          eventId: `evt_${randomUUID()}`,
          threadId: `thread-${randomUUID()}`,
          messageId: `m-${randomUUID()}`,
          from: `${randomUUID()}@example.com`,
          text: 'Hello',
        }),
      });
      expect(result).toEqual({
        accepted: false,
        reason: 'email_channel_disabled',
      });
      const row = await db.query.agentmailWebhookEvents.findFirst({
        where: eq(agentmailWebhookEvents.deliveryId, deliveryId),
      });
      expect(row).toBeUndefined();
    } finally {
      process.env.R_EMAIL_CHANNEL_ENABLED = 'true';
    }
  });

  it('records a delivery as received, dispatches it, and acks duplicates by row state', async () => {
    const deliveryId = `msg_${randomUUID()}`;
    const payload = messageReceivedPayload({
      eventId: `evt_${randomUUID()}`,
      threadId: `thread-${randomUUID()}`,
      messageId: `m-${randomUUID()}`,
      from: `${randomUUID()}@example.com`,
      text: 'Hello',
    });

    const first = await recordAgentMailWebhookEvent({
      deliveryId,
      eventId: null,
      eventType: 'message.received',
      payload,
    });
    expect(first).toEqual({ accepted: true, duplicate: false });

    const row = await db.query.agentmailWebhookEvents.findFirst({
      where: eq(agentmailWebhookEvents.deliveryId, deliveryId),
    });
    expect(row?.state).toBe('queued');

    const retry = await recordAgentMailWebhookEvent({
      deliveryId,
      eventId: null,
      eventType: 'message.received',
      payload,
    });
    expect(retry).toEqual({ accepted: true, duplicate: true });
  });

  it('ignores event types the channel does not consume', async () => {
    const result = await recordAgentMailWebhookEvent({
      deliveryId: `msg_${randomUUID()}`,
      eventId: null,
      eventType: 'message.opened',
      payload: {},
    });
    expect(result).toEqual({ accepted: false, reason: 'ignored_event_type' });
  });

  it('admits a known sender as a durable inbound turn before marking the event processed', async () => {
    const { user, senderEmail } = await createVerifiedSender();

    const deliveryId = `msg_${randomUUID()}`;
    const threadId = `thread-${randomUUID()}`;
    const messageId = `m-${randomUUID()}`;
    await recordAgentMailWebhookEvent({
      deliveryId,
      eventId: null,
      eventType: 'message.received',
      payload: messageReceivedPayload({
        eventId: `evt_${randomUUID()}`,
        threadId,
        messageId,
        from: `Sender <${senderEmail}>`,
        text: 'Please look into the flaky test',
      }),
    });

    await processAgentMailWebhookEvent(deliveryId);

    const eventRow = await db.query.agentmailWebhookEvents.findFirst({
      where: eq(agentmailWebhookEvents.deliveryId, deliveryId),
    });
    expect(eventRow?.state).toBe('processed');

    const conversation = await db.query.agentmailConversations.findFirst({
      where: eq(agentmailConversations.providerThreadId, threadId),
    });
    expect(conversation?.ownerUserId).toBe(user.id);
    // The reply anchor moves when the turn is delivered, not on arrival.
    expect(conversation?.latestInboundMessageId).toBeNull();
    expect(conversation?.latestInboundSenderEmail).toBeNull();

    const turn = await db.query.agentmailInboundTurns.findFirst({
      where: eq(agentmailInboundTurns.conversationId, conversation!.id),
    });
    expect(turn?.state).toBe('pending');
    expect(turn?.providerMessageId).toBe(messageId);

    // Reprocessing the same delivery is a no-op: idempotent on the event row.
    await processAgentMailWebhookEvent(deliveryId);
    const turns = await db.query.agentmailInboundTurns.findMany({
      where: eq(agentmailInboundTurns.conversationId, conversation!.id),
    });
    expect(turns).toHaveLength(1);
  });

  it('drops auto-generated mail without admitting a turn', async () => {
    const { senderEmail } = await createVerifiedSender();

    const deliveryId = `msg_${randomUUID()}`;
    const threadId = `thread-${randomUUID()}`;
    const payload = messageReceivedPayload({
      eventId: `evt_${randomUUID()}`,
      threadId,
      messageId: `m-${randomUUID()}`,
      from: senderEmail,
      text: 'I am out of the office',
    });
    (payload.message as Record<string, unknown>).headers = {
      'Auto-Submitted': 'auto-replied',
    };

    await recordAgentMailWebhookEvent({
      deliveryId,
      eventId: null,
      eventType: 'message.received',
      payload,
    });
    await processAgentMailWebhookEvent(deliveryId);

    const eventRow = await db.query.agentmailWebhookEvents.findFirst({
      where: eq(agentmailWebhookEvents.deliveryId, deliveryId),
    });
    expect(eventRow?.state).toBe('processed');

    const conversation = await db.query.agentmailConversations.findFirst({
      where: eq(agentmailConversations.providerThreadId, threadId),
    });
    expect(conversation).toBeUndefined();
  });

  it('keeps the stranger-refusal claim on ambiguous failures, releases it on definite rejections', async () => {
    const originalFetch = globalThis.fetch;
    const deliverStranger = async (threadId: string, sender: string) => {
      const deliveryId = `msg_${randomUUID()}`;
      await recordAgentMailWebhookEvent({
        deliveryId,
        eventId: null,
        eventType: 'message.received',
        payload: messageReceivedPayload({
          eventId: `evt_${randomUUID()}`,
          threadId,
          messageId: `m-${randomUUID()}`,
          from: sender,
          text: 'Hello from a stranger',
        }),
      });
      await processAgentMailWebhookEvent(deliveryId);
    };

    try {
      // Ambiguous failure (503 after retries): the provider may have sent
      // the refusal, so the once-per-thread claim must be kept.
      const ambiguousThread = `thread-${randomUUID()}`;
      const ambiguousSender = `${randomUUID()}@example.com`;
      globalThis.fetch = (async () =>
        new Response('oops', { status: 503 })) as typeof fetch;
      await deliverStranger(ambiguousThread, ambiguousSender);

      let refusalAttempts = 0;
      globalThis.fetch = (async () => {
        refusalAttempts += 1;
        return new Response(JSON.stringify({ message_id: 'm-refusal' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch;
      await deliverStranger(ambiguousThread, ambiguousSender);
      expect(refusalAttempts).toBe(0);

      // Definite rejection (400): the refusal was never processed, so the
      // claim is released and the next email gets its refusal.
      const rejectedThread = `thread-${randomUUID()}`;
      const rejectedSender = `${randomUUID()}@example.com`;
      globalThis.fetch = (async () =>
        new Response('bad request', { status: 400 })) as typeof fetch;
      await deliverStranger(rejectedThread, rejectedSender);

      globalThis.fetch = (async () => {
        refusalAttempts += 1;
        return new Response(JSON.stringify({ message_id: 'm-refusal' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch;
      await deliverStranger(rejectedThread, rejectedSender);
      expect(refusalAttempts).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('never sends a stranger refusal to a suppressed address, and at most one per sender per day', async () => {
    const originalFetch = globalThis.fetch;
    let refusalAttempts = 0;
    globalThis.fetch = (async () => {
      refusalAttempts += 1;
      return new Response(JSON.stringify({ message_id: 'm-refusal' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const deliverStranger = async (threadId: string, sender: string) => {
      const deliveryId = `msg_${randomUUID()}`;
      await recordAgentMailWebhookEvent({
        deliveryId,
        eventId: null,
        eventType: 'message.received',
        payload: messageReceivedPayload({
          eventId: `evt_${randomUUID()}`,
          threadId,
          messageId: `m-${randomUUID()}`,
          from: sender,
          text: 'Hello from a stranger',
        }),
      });
      await processAgentMailWebhookEvent(deliveryId);
    };

    try {
      const complainer = `${randomUUID()}@example.com`;
      await db.insert(agentmailSuppressions).values({
        emailAddress: complainer,
        reason: 'complaint',
      });
      await deliverStranger(`thread-${randomUUID()}`, complainer);
      expect(refusalAttempts).toBe(0);

      const stranger = `${randomUUID()}@example.com`;
      await deliverStranger(`thread-${randomUUID()}`, stranger);
      await deliverStranger(`thread-${randomUUID()}`, stranger);
      await deliverStranger(`thread-${randomUUID()}`, stranger);
      expect(refusalAttempts).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does nothing in the recovery sweep while the email channel is disabled', async () => {
    const deliveryId = `msg_${randomUUID()}`;
    await recordAgentMailWebhookEvent({
      deliveryId,
      eventId: null,
      eventType: 'message.received',
      payload: messageReceivedPayload({
        eventId: `evt_${randomUUID()}`,
        threadId: `thread-${randomUUID()}`,
        messageId: `m-${randomUUID()}`,
        from: `${randomUUID()}@example.com`,
        text: 'stranded',
      }),
    });
    await db
      .update(agentmailWebhookEvents)
      .set({ state: 'received', updatedAt: new Date(Date.now() - 120_000) })
      .where(eq(agentmailWebhookEvents.deliveryId, deliveryId));

    process.env.R_EMAIL_CHANNEL_ENABLED = 'false';
    try {
      await expect(recoverPendingAgentMailWork()).resolves.toBe(0);
    } finally {
      process.env.R_EMAIL_CHANNEL_ENABLED = 'true';
    }
    await expect(recoverPendingAgentMailWork()).resolves.toBeGreaterThan(0);
  });

  it('suppresses recipients of permanent bounces and complaints, but not transient bounces', async () => {
    const bounced = `${randomUUID()}@example.com`;
    const complained = `${randomUUID()}@example.com`;
    const transient = `${randomUUID()}@example.com`;

    const record = async (eventType: string, payload: unknown) => {
      const deliveryId = `msg_${randomUUID()}`;
      await recordAgentMailWebhookEvent({
        deliveryId,
        eventId: null,
        eventType,
        payload,
      });
      await processAgentMailWebhookEvent(deliveryId);
      const row = await db.query.agentmailWebhookEvents.findFirst({
        where: eq(agentmailWebhookEvents.deliveryId, deliveryId),
      });
      expect(row?.state).toBe('processed');
    };

    await record('message.bounced', {
      type: 'event',
      event_type: 'message.bounced',
      event_id: `evt_${randomUUID()}`,
      bounce: {
        inbox_id: INBOX,
        message_id: `<${randomUUID()}@agentmail.to>`,
        type: 'Permanent',
        sub_type: 'General',
        recipients: [{ address: bounced, status: 'bounced' }],
      },
    });
    await record('message.complained', {
      type: 'event',
      event_type: 'message.complained',
      event_id: `evt_${randomUUID()}`,
      complaint: {
        inbox_id: INBOX,
        message_id: `<${randomUUID()}@agentmail.to>`,
        type: 'abuse',
        sub_type: 'spam',
        recipients: [complained],
      },
    });
    await record('message.bounced', {
      type: 'event',
      event_type: 'message.bounced',
      event_id: `evt_${randomUUID()}`,
      bounce: {
        inbox_id: INBOX,
        message_id: `<${randomUUID()}@agentmail.to>`,
        type: 'Transient',
        sub_type: 'MailboxFull',
        recipients: [{ address: transient, status: 'bounced' }],
      },
    });

    expect(await isAgentMailAddressSuppressed(bounced)).toBe(true);
    expect(await isAgentMailAddressSuppressed(complained)).toBe(true);
    expect(await isAgentMailAddressSuppressed(transient)).toBe(false);

    const bounceRow = await db.query.agentmailSuppressions.findFirst({
      where: eq(agentmailSuppressions.emailAddress, bounced),
    });
    expect(bounceRow).toMatchObject({
      reason: 'bounce',
      details: 'Permanent/General',
    });
    const complaintRow = await db.query.agentmailSuppressions.findFirst({
      where: eq(agentmailSuppressions.emailAddress, complained),
    });
    expect(complaintRow?.reason).toBe('complaint');
  });
});

describe('agentmail inbound turn drain (real database)', () => {
  beforeAll(() => {
    process.env.R_EMAIL_CHANNEL_ENABLED = 'true';
    process.env.R_AGENTMAIL_API_KEY = 'am_test_key';
    process.env.R_AGENTMAIL_WEBHOOK_SECRET = 'whsec_dGVzdA==';
    process.env.R_AGENTMAIL_INBOX_ID = INBOX;
  });

  beforeEach(() => {
    mocks.continueWithLock.mockReset();
  });

  async function seedConversation(turnTexts: string[]) {
    const { user, senderEmail } = await createVerifiedSender();
    const threadId = `thread-${randomUUID()}`;
    const messageIds: string[] = [];
    const base = Date.now() - 60_000;
    for (const [index, text] of turnTexts.entries()) {
      const deliveryId = `msg_${randomUUID()}`;
      const messageId = `m-${index}-${randomUUID()}`;
      messageIds.push(messageId);
      await recordAgentMailWebhookEvent({
        deliveryId,
        eventId: null,
        eventType: 'message.received',
        payload: messageReceivedPayload({
          eventId: `evt_${randomUUID()}`,
          threadId,
          messageId,
          from: senderEmail,
          text,
          timestamp: new Date(base + index * 1_000).toISOString(),
        }),
      });
      await processAgentMailWebhookEvent(deliveryId);
    }
    const conversation = await db.query.agentmailConversations.findFirst({
      where: eq(agentmailConversations.providerThreadId, threadId),
    });
    return { user, senderEmail, conversation: conversation!, messageIds };
  }

  async function loadTurns(conversationId: string) {
    return db.query.agentmailInboundTurns.findMany({
      where: eq(agentmailInboundTurns.conversationId, conversationId),
      orderBy: [asc(agentmailInboundTurns.providerTimestamp)],
    });
  }

  it('delivers turns in order, advancing the reply anchor to each turn before it runs', async () => {
    const { conversation, messageIds } = await seedConversation([
      'first',
      'second',
    ]);
    const anchorsSeen: (string | null)[] = [];
    mocks.continueWithLock.mockImplementation(async () => {
      const row = await db.query.agentmailConversations.findFirst({
        where: eq(agentmailConversations.id, conversation.id),
        columns: { latestInboundMessageId: true },
      });
      anchorsSeen.push(row?.latestInboundMessageId ?? null);
      return { outcome: 'delivered' };
    });

    await drainAgentMailInboundTurns(conversation.id);

    expect(anchorsSeen).toEqual(messageIds);
    const turns = await loadTurns(conversation.id);
    expect(turns.map((turn) => turn.state)).toEqual(['consumed', 'consumed']);
    expect(mocks.continueWithLock.mock.calls.map(([params]) => params)).toEqual(
      [
        expect.objectContaining({ currentMessageId: messageIds[0] }),
        expect.objectContaining({ currentMessageId: messageIds[1] }),
      ],
    );
  });

  it('holds the conversation on a parked turn instead of running the next email over it', async () => {
    const { conversation } = await seedConversation(['first', 'second']);
    const retryAt = new Date(Date.now() + 5 * 60_000);
    mocks.continueWithLock.mockResolvedValueOnce({
      outcome: 'parked',
      retryAt,
    });

    await drainAgentMailInboundTurns(conversation.id);

    expect(mocks.continueWithLock).toHaveBeenCalledTimes(1);
    const turns = await loadTurns(conversation.id);
    expect(turns[0]).toMatchObject({ state: 'pending' });
    expect(turns[0]!.retryAt?.getTime()).toBe(retryAt.getTime());
    expect(turns[1]).toMatchObject({ state: 'pending', retryAt: null });

    // Still parked: a fresh drain does not touch either turn.
    await drainAgentMailInboundTurns(conversation.id);
    expect(mocks.continueWithLock).toHaveBeenCalledTimes(1);

    // Due: the parked turn runs first, then the next one.
    await db
      .update(agentmailInboundTurns)
      .set({ retryAt: new Date(Date.now() - 1_000) })
      .where(eq(agentmailInboundTurns.id, turns[0]!.id));
    mocks.continueWithLock.mockResolvedValue({ outcome: 'delivered' });
    await drainAgentMailInboundTurns(conversation.id);
    expect(mocks.continueWithLock).toHaveBeenCalledTimes(3);
    expect(
      (await loadTurns(conversation.id)).map((turn) => turn.state),
    ).toEqual(['consumed', 'consumed']);
  });

  it('consumes a turn the queue already settled without re-running it', async () => {
    const { conversation } = await seedConversation(['first']);
    mocks.continueWithLock.mockResolvedValue({ outcome: 'settled' });

    await drainAgentMailInboundTurns(conversation.id);

    expect((await loadTurns(conversation.id))[0]?.state).toBe('consumed');
  });

  it('leaves turns pending when the session has no delivery route', async () => {
    const { conversation } = await seedConversation(['first']);
    mocks.continueWithLock.mockResolvedValue({ outcome: 'unroutable' });

    await drainAgentMailInboundTurns(conversation.id);

    expect((await loadTurns(conversation.id))[0]).toMatchObject({
      state: 'pending',
      attempts: 0,
    });
  });

  it('dead-letters a turn after repeated failures so later emails get through', async () => {
    const originalFetch = globalThis.fetch;
    let notices = 0;
    globalThis.fetch = (async () => {
      notices += 1;
      return new Response(JSON.stringify({ message_id: 'm-notice' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const { conversation, messageIds } = await seedConversation([
        'poison',
        'after',
      ]);
      mocks.continueWithLock.mockImplementation(
        async ({ currentMessageId }) => {
          if (currentMessageId === messageIds[0]) {
            throw new Error('inference exploded');
          }
          return { outcome: 'delivered' };
        },
      );

      for (let attempt = 1; attempt < 5; attempt += 1) {
        await expect(
          drainAgentMailInboundTurns(conversation.id),
        ).rejects.toThrow('inference exploded');
        const [poison, after] = await loadTurns(conversation.id);
        expect(poison).toMatchObject({
          state: 'pending',
          attempts: attempt,
          lastError: 'inference exploded',
        });
        expect(after?.state).toBe('pending');
      }

      // The capping attempt dead-letters the turn and drains past it.
      await drainAgentMailInboundTurns(conversation.id);
      const [poison, after] = await loadTurns(conversation.id);
      expect(poison).toMatchObject({ state: 'failed', attempts: 5 });
      expect(after?.state).toBe('consumed');
      expect(notices).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('is a no-op while the email channel is disabled', async () => {
    const { conversation } = await seedConversation(['first']);
    process.env.R_EMAIL_CHANNEL_ENABLED = 'false';
    try {
      await drainAgentMailInboundTurns(conversation.id);
    } finally {
      process.env.R_EMAIL_CHANNEL_ENABLED = 'true';
    }
    expect(mocks.continueWithLock).not.toHaveBeenCalled();
    expect((await loadTurns(conversation.id))[0]?.state).toBe('pending');
  });

  afterAll(async () => {
    await getRedis()
      .quit()
      .catch(() => undefined);
  });
});
