import { createHash, timingSafeEqual } from 'node:crypto';

import { Hono } from 'hono';
import type { Context } from 'hono';

import {
  and,
  db,
  eq,
  getCustomAutomationWebhookState,
  isNull,
  users,
} from '@roomote/db/server';
import { runCustomAutomationNow } from '@roomote/sdk/server';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MAX_REQUEST_BODY_BYTES = 64 * 1024;

function sameToken(candidate: string, stored: string): boolean {
  const candidateDigest = createHash('sha256').update(candidate).digest();
  const storedDigest = createHash('sha256').update(stored).digest();
  return timingSafeEqual(candidateDigest, storedDigest);
}

function respond(
  c: Context,
  status: 202 | 404 | 405 | 413 | 503,
  body: { accepted: true } | { error: string },
) {
  c.header('Cache-Control', 'no-store, private');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Robots-Tag', 'noindex');
  return c.json(body, status);
}

function hasOversizedDeclaredBody(request: Request): boolean {
  const contentLength = Number(request.headers.get('content-length'));
  return (
    Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BODY_BYTES
  );
}

async function bodyExceedsLimit(request: Request): Promise<boolean> {
  if (!request.body) return false;
  const reader = request.body.getReader();
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return false;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel();
        return true;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export const customAutomationWebhooks = new Hono();

customAutomationWebhooks.all('/:id/:token', async (c) => {
  if (c.req.method !== 'POST') {
    c.header('Allow', 'POST');
    return respond(c, 405, { error: 'method_not_allowed' });
  }

  if (hasOversizedDeclaredBody(c.req.raw)) {
    return respond(c, 413, { error: 'payload_too_large' });
  }

  const { id, token } = c.req.param();
  if (!TOKEN_PATTERN.test(token)) {
    return respond(c, 404, { error: 'not_found' });
  }

  const webhook = await getCustomAutomationWebhookState(id);
  if (
    !webhook?.enabled ||
    !webhook.createdByUserId ||
    !webhook.token ||
    !sameToken(token, webhook.token)
  ) {
    return respond(c, 404, { error: 'not_found' });
  }

  const owner = await db.query.users.findFirst({
    where: and(eq(users.id, webhook.createdByUserId), isNull(users.deletedAt)),
    columns: { id: true },
  });
  if (!owner) {
    return respond(c, 404, { error: 'not_found' });
  }

  if (await bodyExceedsLimit(c.req.raw)) {
    return respond(c, 413, { error: 'payload_too_large' });
  }

  // Request bodies are deliberately discarded; only the configured prompt is
  // trusted input to this run. The URL is the sole trigger credential.
  const result = await runCustomAutomationNow(id, 'webhook');
  if (
    result.outcome === 'failed' ||
    (result.outcome === 'skipped' &&
      result.reason !== 'Another launch is already in progress.')
  ) {
    return respond(c, 503, { error: 'trigger_failed' });
  }

  return respond(c, 202, { accepted: true });
});
