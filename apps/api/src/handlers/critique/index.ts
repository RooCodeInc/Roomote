import { Hono } from 'hono';
import { Env } from '@roomote/env';
import { validateCritiqueSubmissionCapability } from '@roomote/compute-providers';
import {
  CRITIQUE_CAPABILITY_HEADER,
  type RunTokenContext,
} from '@roomote/types';

import type { Variables } from '../../types';
import { logHandlerError } from '../utils';

const MAX_CRITIQUE_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_CRITIQUE_RESPONSE_BYTES = 4 * 1024 * 1024;
const CRITIQUE_TIMEOUT_MS = 160_000;

class RequestBodyTooLargeError extends Error {}

function isRunTokenContext(
  auth: Variables['authContext'],
): auth is RunTokenContext {
  return Boolean(auth && 'runId' in auth);
}

async function readBoundedBytes(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RequestBodyTooLargeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function safeUpstreamDetail(
  payload: unknown,
  secret: string,
): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const candidate =
    typeof record.error === 'string'
      ? record.error
      : typeof record.message === 'string'
        ? record.message
        : undefined;
  return candidate?.split(secret).join('[REDACTED]').slice(0, 1_000);
}

export const critique = new Hono<{ Variables: Variables }>();

critique.post('/', async (c) => {
  if (!Env.CRITIQUE_BASE_URL || !Env.CRITIQUE_API_TOKEN) {
    return c.json({ error: 'Critique visual review is not configured' }, 404);
  }

  const auth = c.get('authContext');
  if (!isRunTokenContext(auth)) {
    return c.json({ error: 'Critique requires a task run token' }, 403);
  }

  const runToken = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (
    !runToken ||
    !validateCritiqueSubmissionCapability({
      capability: c.req.header(CRITIQUE_CAPABILITY_HEADER),
      runToken,
      signingKeys: [
        Env.ARTIFACT_SIGNING_KEY,
        ...(Env.ARTIFACT_SIGNING_KEY_PREVIOUS
          ? [Env.ARTIFACT_SIGNING_KEY_PREVIOUS]
          : []),
      ],
    })
  ) {
    return c.json({ error: 'Invalid Critique submission capability' }, 403);
  }

  const contentType = c.req.header('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data;')) {
    return c.json({ error: 'Critique requires multipart/form-data' }, 400);
  }

  const declaredLength = Number(c.req.header('content-length'));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_CRITIQUE_REQUEST_BYTES
  ) {
    return c.json(
      { error: `Critique request exceeds ${MAX_CRITIQUE_REQUEST_BYTES} bytes` },
      413,
    );
  }

  let body: Uint8Array;
  try {
    body = await readBoundedBytes(c.req.raw.body, MAX_CRITIQUE_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return c.json(
        {
          error: `Critique request exceeds ${MAX_CRITIQUE_REQUEST_BYTES} bytes`,
        },
        413,
      );
    }
    return c.json({ error: 'Failed to read Critique request' }, 400);
  }

  const timeoutSignal = AbortSignal.timeout(CRITIQUE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(
      `${Env.CRITIQUE_BASE_URL.replace(/\/$/, '')}/v1/critiques`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${Env.CRITIQUE_API_TOKEN}`,
          'content-type': contentType,
          'content-length': String(body.byteLength),
        },
        body: new Blob([Uint8Array.from(body)]),
        signal: timeoutSignal,
      },
    );
  } catch (error) {
    if (timeoutSignal.aborted) {
      return c.json(
        {
          error: `Critique timed out after ${CRITIQUE_TIMEOUT_MS}ms; the paid request outcome is uncertain and must not be retried automatically`,
        },
        504,
      );
    }
    logHandlerError('critique', error);
    return c.json({ error: 'Critique request failed before a response' }, 502);
  }

  let responseBytes: Uint8Array;
  try {
    responseBytes = await readBoundedBytes(
      response.body,
      MAX_CRITIQUE_RESPONSE_BYTES,
    );
  } catch (error) {
    logHandlerError('critiqueResponse', error);
    return c.json({ error: 'Critique response exceeded the size limit' }, 502);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(responseBytes));
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const detail = safeUpstreamDetail(payload, Env.CRITIQUE_API_TOKEN);
    if (response.status >= 400 && response.status < 500) {
      return c.json(
        {
          error:
            'Critique rejected the capture or input; do not retry unchanged',
          upstreamStatus: response.status,
          ...(detail ? { detail } : {}),
        },
        400,
      );
    }
    if (response.status === 502 || response.status === 503) {
      return c.json(
        {
          error: 'Critique service is unavailable',
          upstreamStatus: response.status,
          ...(detail ? { detail } : {}),
        },
        response.status,
      );
    }
    return c.json(
      {
        error: 'Critique service returned an error',
        upstreamStatus: response.status,
        ...(detail ? { detail } : {}),
      },
      502,
    );
  }

  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    !['completed', 'partial'].includes(
      String((payload as Record<string, unknown>).status),
    ) ||
    !Array.isArray((payload as Record<string, unknown>).findings)
  ) {
    return c.json({ error: 'Critique returned an invalid response' }, 502);
  }

  return c.json(payload);
});
