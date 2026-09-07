import { Hono } from 'hono';

import type { Variables } from '../../types';
import type { McpAuth } from './middleware';
import { toMcpToolResult } from './proxy-utils';

type InProcessApp = Hono<{
  Variables: Variables & { mcpAuth: McpAuth };
}>;

export type InProcessApiResult = {
  ok: boolean;
  status: number;
  payload: Record<string, unknown>;
};

export function toolError(payload: Record<string, unknown>) {
  return { ...toMcpToolResult(payload), isError: true as const };
}

/**
 * Invoke API routers in-process on behalf of an MCP tool handler, with the
 * caller's auth impersonated into the request context. The routers rethrow
 * unexpected errors expecting an app-level handler, and this synthetic app is
 * not behind the API server's onError, so it carries its own JSON handler and
 * tolerates non-JSON responses.
 */
export async function invokeInProcessApi(options: {
  auth: McpAuth;
  mount: (app: InProcessApp) => void;
  path: string;
  init?: RequestInit;
}): Promise<InProcessApiResult> {
  const app: InProcessApp = new Hono();
  app.onError((error, c) => {
    console.error('[mcp] Unhandled in-process API error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  });
  app.use('*', async (c, next) => {
    c.set('authContext', options.auth.authContext);
    c.set('mcpAuth', options.auth);
    await next();
  });
  options.mount(app);

  const response = await app.request(
    `http://roomote.internal${options.path}`,
    options.init,
  );
  const rawText = await response.text();
  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(rawText) as unknown;
  } catch {
    rawPayload = { error: rawText || `Request failed (${response.status})` };
  }
  const payload =
    rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)
      ? (rawPayload as Record<string, unknown>)
      : { result: rawPayload };

  return { ok: response.ok, status: response.status, payload };
}

// status is always the numeric HTTP code; a body carrying its own `status`
// marker must not clobber it.
export function toolResultFromApi(result: InProcessApiResult) {
  return result.ok
    ? toMcpToolResult(result.payload)
    : toolError({ ...result.payload, status: result.status });
}
