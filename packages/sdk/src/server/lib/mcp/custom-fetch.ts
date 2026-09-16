import { Env } from '@roomote/env';

import { createGuardedFetch } from '../safe-fetch';

const CUSTOM_MCP_FETCH_TIMEOUT_MS = 10_000;
const CUSTOM_MCP_RESPONSE_MAX_BYTES = 1024 * 1024;

class CustomMcpResponseTooLargeError extends Error {
  constructor() {
    super(
      `Custom MCP response exceeds ${CUSTOM_MCP_RESPONSE_MAX_BYTES} bytes.`,
    );
    this.name = 'CustomMcpResponseTooLargeError';
  }
}

async function readBoundedCustomMcpResponse(
  response: Response,
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > CUSTOM_MCP_RESPONSE_MAX_BYTES
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new CustomMcpResponseTooLargeError();
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > CUSTOM_MCP_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new CustomMcpResponseTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function createBoundedCustomMcpFetch() {
  const guardedFetch = createGuardedFetch(
    Env.R_CUSTOM_MCP_ALLOWED_PRIVATE_CIDRS,
  );
  return async (
    url: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<Response> => {
    const timeoutSignal = AbortSignal.timeout(CUSTOM_MCP_FETCH_TIMEOUT_MS);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    const response = await guardedFetch(url, { ...init, signal });
    const body = await readBoundedCustomMcpResponse(response);
    return new Response(body.byteLength > 0 ? Buffer.from(body) : null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
