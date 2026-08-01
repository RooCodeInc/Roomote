import { Hono } from 'hono';
import { ZodError } from 'zod';

import {
  db,
  eq,
  getMondayAgentInstallationSecrets,
  webhooks,
} from '@roomote/db/server';
import { Env } from '@roomote/env';
import {
  createMondayAgentResponse,
  createMondayWebhookDeliveryId,
  isMondayWebhookTimestampFresh,
  MONDAY_WEBHOOK_MAX_BODY_BYTES,
  parseMondayWebhook,
  verifyMondayWebhookSignature,
} from '@roomote/monday';

import { redactWebhookPayload } from '../webhook-payload-redaction';

const INACTIVE_MESSAGE =
  'Roomote is connected, but monday.com task entry is not active yet.';

export const monday = new Hono();

function agentResponse(message: string, stream: boolean): Response {
  const response = createMondayAgentResponse(message, stream);
  return new Response(response.body, {
    status: 200,
    headers: {
      'Content-Type': response.contentType,
      ...(response.contentType === 'text/event-stream'
        ? {
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          }
        : {}),
    },
  });
}

monday.post('/agent', async (c) => {
  if (!Env.R_MONDAY_AGENT_ENABLED) {
    return c.json({ error: 'not_found' }, { status: 404 });
  }

  const declaredLength = Number(c.req.header('content-length') ?? '0');
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MONDAY_WEBHOOK_MAX_BODY_BYTES
  ) {
    return c.json({ error: 'payload_too_large' }, { status: 413 });
  }

  const rawBody = await c.req.text();
  if (Buffer.byteLength(rawBody) > MONDAY_WEBHOOK_MAX_BODY_BYTES) {
    return c.json({ error: 'payload_too_large' }, { status: 413 });
  }

  const agentId = c.req.header('x-monday-agent-id') ?? '';
  const signature = c.req.header('x-monday-signature') ?? '';
  const timestamp = c.req.header('x-monday-timestamp') ?? '';
  if (!agentId || !signature || !timestamp) {
    return c.json({ error: 'missing_signature_headers' }, { status: 400 });
  }

  if (!isMondayWebhookTimestampFresh(timestamp)) {
    return c.json({ error: 'stale_timestamp' }, { status: 401 });
  }

  const installation = await getMondayAgentInstallationSecrets(agentId);
  if (!installation) {
    return c.json({ error: 'unknown_agent' }, { status: 404 });
  }

  if (
    !verifyMondayWebhookSignature({
      rawBody,
      timestamp,
      signature,
      signingSecret: installation.signingSecret,
    })
  ) {
    return c.json({ error: 'invalid_signature' }, { status: 401 });
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody) as unknown;
  } catch {
    return c.json({ error: 'invalid_json' }, { status: 400 });
  }

  let parsed;
  try {
    parsed = parseMondayWebhook(parsedBody);
  } catch (error) {
    if (error instanceof ZodError) {
      return c.json({ error: 'unsupported_event' }, { status: 400 });
    }
    throw error;
  }

  if (installation.status !== 'inactive') {
    return c.json({ error: 'installation_unavailable' }, { status: 503 });
  }

  if (parsed.type === 'challenge') {
    return c.json({ challenge: parsed.challenge });
  }

  const deliveryId = createMondayWebhookDeliveryId({
    agentId,
    timestamp,
    rawBody,
  });
  const [claimed] = await db
    .insert(webhooks)
    .values({
      deliveryId,
      provider: 'monday',
      event: `agent.${parsed.trigger.triggerType}`,
      payload: redactWebhookPayload({
        event: parsed.trigger.event,
        triggerType: parsed.trigger.triggerType,
        timestamp: parsed.trigger.timestamp,
      }),
    })
    .onConflictDoNothing()
    .returning({ id: webhooks.id });

  if (claimed) {
    await db
      .update(webhooks)
      .set({ succeededAt: new Date() })
      .where(eq(webhooks.id, claimed.id));
  } else {
    return c.json({ error: 'duplicate_delivery' }, { status: 409 });
  }

  return agentResponse(INACTIVE_MESSAGE, parsed.trigger.stream !== false);
});
