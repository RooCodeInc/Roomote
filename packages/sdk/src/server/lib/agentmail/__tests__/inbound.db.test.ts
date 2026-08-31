import { randomUUID } from 'node:crypto';

import {
  agentmailConversations,
  agentmailInboundTurns,
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
    process.env.R_AGENTMAIL_API_KEY = 'am_test_key';
    process.env.R_AGENTMAIL_WEBHOOK_SECRET = 'whsec_dGVzdA==';
    process.env.R_AGENTMAIL_INBOX_ID = INBOX;
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
});
