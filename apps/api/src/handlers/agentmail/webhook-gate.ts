import { Webhook } from 'svix';

import { resolveAgentMailRuntimeCredentials } from '@roomote/db/server';

type AgentMailWebhookVerification =
  | { ok: true; deliveryId: string }
  | { ok: false; status: 401 | 503; error: string };

/**
 * Verify an AgentMail webhook delivery. AgentMail delivers through Svix, so
 * verification uses the svix library (signature, timestamp tolerance, and
 * replay validation together) over the RAW body — never a hand-rolled HMAC.
 */
export async function verifyAgentMailWebhook(input: {
  rawBody: string;
  headers: {
    svixId: string | undefined;
    svixTimestamp: string | undefined;
    svixSignature: string | undefined;
  };
}): Promise<AgentMailWebhookVerification> {
  const { webhookSecret } = await resolveAgentMailRuntimeCredentials();

  if (!webhookSecret) {
    return {
      ok: false,
      status: 503,
      error: 'AgentMail webhook secret is not configured.',
    };
  }

  const { svixId, svixTimestamp, svixSignature } = input.headers;
  if (!svixId || !svixTimestamp || !svixSignature) {
    return {
      ok: false,
      status: 401,
      error: 'Missing Svix signature headers.',
    };
  }

  try {
    new Webhook(webhookSecret).verify(input.rawBody, {
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': svixSignature,
    });
  } catch {
    return {
      ok: false,
      status: 401,
      error: 'Invalid webhook signature.',
    };
  }

  return { ok: true, deliveryId: svixId };
}
