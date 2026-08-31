import { Hono } from 'hono';

import { recordAgentMailWebhookEvent } from '@roomote/sdk/server';

import { apiLogger } from '../../logging.js';
import { verifyAgentMailWebhook } from './webhook-gate.js';

export const agentmail = new Hono();

/**
 * Inbound AgentMail webhook. The contract with the durable ingestion
 * pipeline: verify the Svix signature over the raw body, record the delivery
 * in the `agentmail_webhook_events` outbox, dispatch its processing job, and
 * only then return 200. Processing (sender resolution, conversation routing,
 * Fast admission) happens asynchronously from the BullMQ queue; a crash after
 * this 200 can never lose an email because the outbox row is the commitment.
 */
agentmail.post('/', async (c) => {
  const rawBody = await c.req.text();

  const verification = await verifyAgentMailWebhook({
    rawBody,
    headers: {
      svixId: c.req.header('svix-id'),
      svixTimestamp: c.req.header('svix-timestamp'),
      svixSignature: c.req.header('svix-signature'),
    },
  });

  if (!verification.ok) {
    return c.json(
      { ok: false, error: verification.error },
      verification.status,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON body.' }, 400);
  }

  const eventType =
    payload && typeof payload === 'object' && 'event_type' in payload
      ? String((payload as { event_type: unknown }).event_type)
      : '';
  const eventId =
    payload && typeof payload === 'object' && 'event_id' in payload
      ? String((payload as { event_id: unknown }).event_id)
      : null;

  const result = await recordAgentMailWebhookEvent({
    deliveryId: verification.deliveryId,
    eventId,
    eventType,
    payload,
  });

  if (!result.accepted) {
    return c.json({ ok: true, ignored: result.reason });
  }

  if (result.duplicate) {
    apiLogger.debug(
      `[agentmail] Duplicate delivery ${verification.deliveryId} acknowledged`,
    );
  }

  return c.json({ ok: true, queued: true, duplicate: result.duplicate });
});
