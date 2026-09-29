import { createHash, timingSafeEqual } from 'node:crypto';

import { Hono } from 'hono';
import type { Context } from 'hono';

import { getBackgroundAutomationWebhookState } from '@roomote/db/server';
import {
  isBuiltInWebhookAutomationKey,
  isTriggerableBackgroundAutomationKey,
  type TriggerableBackgroundAutomationKey,
} from '@roomote/types';
import { enqueueBuiltInAutomationWebhook } from '@roomote/sdk/server';

import {
  MAX_REQUEST_BODY_BYTES,
  readWebhookInput,
} from '../custom-automation-webhooks';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

function sameToken(candidate: string, stored: string): boolean {
  const candidateDigest = createHash('sha256').update(candidate).digest();
  const storedDigest = createHash('sha256').update(stored).digest();
  return timingSafeEqual(candidateDigest, storedDigest);
}

function respond(
  c: Context,
  status: 202 | 400 | 404 | 405 | 413 | 415 | 503,
  body: { accepted: true } | { error: string },
) {
  c.header('Cache-Control', 'no-store, private');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Robots-Tag', 'noindex');
  return c.json(body, status);
}

export const builtInAutomationWebhooks = new Hono();

builtInAutomationWebhooks.all('/:automationKey/:token', async (c) => {
  if (c.req.method !== 'POST') {
    c.header('Allow', 'POST');
    return respond(c, 405, { error: 'method_not_allowed' });
  }

  const contentLength = Number(c.req.header('content-length'));
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_REQUEST_BODY_BYTES
  ) {
    return respond(c, 413, { error: 'payload_too_large' });
  }

  const { automationKey, token } = c.req.param();
  if (
    !isTriggerableBackgroundAutomationKey(automationKey) ||
    !isBuiltInWebhookAutomationKey(automationKey) ||
    !TOKEN_PATTERN.test(token)
  ) {
    return respond(c, 404, { error: 'not_found' });
  }

  const webhook = await getBackgroundAutomationWebhookState(
    automationKey as TriggerableBackgroundAutomationKey,
  );
  if (!webhook?.enabled || !webhook.token || !sameToken(token, webhook.token)) {
    return respond(c, 404, { error: 'not_found' });
  }

  const webhookInput = await readWebhookInput(c.req.raw);
  if (!webhookInput.ok) {
    return respond(c, webhookInput.status, { error: webhookInput.error });
  }

  try {
    await enqueueBuiltInAutomationWebhook({
      automationKey: automationKey as TriggerableBackgroundAutomationKey,
      webhookInputJson: webhookInput.promptInputJson,
    });
  } catch (error) {
    console.error(
      `[built-in-automation-webhooks] Failed to admit ${automationKey}:`,
      error instanceof Error ? error.message : error,
    );
    return respond(c, 503, { error: 'trigger_failed' });
  }

  return respond(c, 202, { accepted: true });
});
