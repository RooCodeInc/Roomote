import { randomUUID } from 'node:crypto';

import {
  agentmailConversations,
  agentmailInboundTurns,
  agentmailSuppressions,
  agentmailUserMappings,
  agentmailWebhookEvents,
  db,
  eq,
  userFactory,
} from '@roomote/db/server';

import {
  processAgentMailWebhookEvent,
  recordAgentMailWebhookEvent,
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
    const user = await userFactory.create();
    const senderEmail = `${randomUUID()}@example.com`;
    await db.insert(agentmailUserMappings).values({
      emailAddress: senderEmail,
      userId: user.id,
      source: 'link_code',
    });

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
    expect(conversation?.latestInboundMessageId).toBe(messageId);
    expect(conversation?.latestInboundSenderEmail).toBe(senderEmail);

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
    const user = await userFactory.create();
    const senderEmail = `${randomUUID()}@example.com`;
    await db.insert(agentmailUserMappings).values({
      emailAddress: senderEmail,
      userId: user.id,
      source: 'link_code',
    });

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
