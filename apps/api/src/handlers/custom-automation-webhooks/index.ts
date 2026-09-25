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

type WebhookInputReadResult =
  | { ok: true; promptInputJson: string | null }
  | { ok: false; status: 400 | 413 | 415; error: string };

class RequestBodyTooLargeError extends Error {}

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

function hasOversizedDeclaredBody(request: Request): boolean {
  const contentLength = Number(request.headers.get('content-length'));
  return (
    Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BODY_BYTES
  );
}

async function readRequestBodyBytes(request: Request): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function encodeUntrustedJson(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

async function readWebhookInput(
  request: Request,
): Promise<WebhookInputReadResult> {
  let body: Uint8Array;
  try {
    body = await readRequestBodyBytes(request);
  } catch (error) {
    return error instanceof RequestBodyTooLargeError
      ? { ok: false, status: 413, error: 'payload_too_large' }
      : { ok: false, status: 400, error: 'invalid_body' };
  }
  if (body.byteLength === 0) {
    return { ok: true, promptInputJson: null };
  }

  const contentEncoding = request.headers
    .get('content-encoding')
    ?.trim()
    .toLowerCase();
  if (contentEncoding && contentEncoding !== 'identity') {
    return { ok: false, status: 415, error: 'unsupported_media_type' };
  }

  const contentType = request.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  const charset = /(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/iu
    .exec(request.headers.get('content-type') ?? '')?.[1]
    ?.toLowerCase();
  const isJson =
    contentType === 'application/json' ||
    (contentType?.startsWith('application/') === true &&
      contentType.endsWith('+json'));
  if (
    (contentType !== 'text/plain' && !isJson) ||
    (charset && charset !== 'utf-8' && charset !== 'utf8')
  ) {
    return { ok: false, status: 415, error: 'unsupported_media_type' };
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return { ok: false, status: 400, error: 'invalid_encoding' };
  }
  if (!isJson) {
    return { ok: true, promptInputJson: encodeUntrustedJson(text) };
  }

  try {
    return {
      ok: true,
      promptInputJson: encodeUntrustedJson(JSON.parse(text) as unknown),
    };
  } catch {
    return { ok: false, status: 400, error: 'invalid_json' };
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

  const webhookInput = await readWebhookInput(c.req.raw);
  if (!webhookInput.ok) {
    return respond(c, webhookInput.status, { error: webhookInput.error });
  }

  // The parsed body is passed only to this run and remains explicitly untrusted
  // prompt data; the saved automation prompt and URL credential are unchanged.
  const result = webhookInput.promptInputJson
    ? await runCustomAutomationNow(id, 'webhook', webhookInput.promptInputJson)
    : await runCustomAutomationNow(id, 'webhook');
  if (result.outcome === 'failed' || result.outcome === 'skipped') {
    return respond(c, 503, { error: 'trigger_failed' });
  }

  return respond(c, 202, { accepted: true });
});
