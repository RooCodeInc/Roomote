import { createServer } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { DEFAULT_AUTH_BYPASS_HEADER_NAME } from '@roomote/types';

/** A loopback capability for Jevgrep only; the run bearer stays in the worker. */
export async function startJevgrepProxy(options: {
  endpoint: string;
  token: string;
  bypassHeader?: string;
  bypassValue?: string;
}) {
  const shutdown = new AbortController();
  const app = new Hono();
  app.use('*', bodyLimit({ maxSize: 2 * 1024 * 1024 }));
  app.post('/v1/systemone', async (c) => {
    if (
      c.req.header('origin') ||
      c.req.header('content-type')?.split(';')[0]?.trim() !== 'application/json'
    ) {
      return c.json({ error: 'Expected a local JSON request' }, 403);
    }
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${options.token}`,
    };
    if (options.bypassValue) {
      headers[options.bypassHeader || DEFAULT_AUTH_BYPASS_HEADER_NAME] =
        options.bypassValue;
    }
    try {
      const response = await fetch(options.endpoint, {
        method: 'POST',
        headers,
        body: await c.req.text(),
        redirect: 'error',
        signal: AbortSignal.any([
          shutdown.signal,
          c.req.raw.signal,
          AbortSignal.timeout(20_000),
        ]),
      });
      if (response.status === 200) return c.json(await response.json());
      // Do not expose upstream headers, diagnostics, or redirect destinations.
      const status = [400, 403, 413, 429, 502, 503].includes(response.status)
        ? response.status
        : 502;
      await response.body?.cancel();
      return Response.json(
        { error: 'Jevgrep evaluation unavailable' },
        { status },
      );
    } catch {
      return c.json({ error: 'Jevgrep evaluation unavailable' }, 502);
    }
  });
  const listener = getRequestListener(app.fetch, {
    overrideGlobalObjects: false,
  });
  const server = createServer((request, response) => {
    // A cancelled CLI or rejected upload must not crash the worker on EPIPE.
    response.on('error', () => response.destroy());
    void listener(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
    server.listen(0, '127.0.0.1');
  });
  server.unref();
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Jevgrep proxy failed to listen');
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1/systemone`,
    close: async () => {
      shutdown.abort();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
