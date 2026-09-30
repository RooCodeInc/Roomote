import { createServer } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { MAX_EVIDENCE_BYTES, type JudgeRequest } from '@roo-code/judgement';
import { buildWorkerHeaders, createClient } from '@roomote/sdk/client';

/** The hook receives only a loopback capability; the run bearer stays here. */
export async function startJudgementProxy(env: NodeJS.ProcessEnv) {
  const runId = Number(env.ROOMOTE_TASK_RUN_ID);
  const url = env.ROOMOTE_PLATFORM_API_URL;
  const token = env.ROOMOTE_CLOUD_TOKEN;
  if (!url || !token || !Number.isSafeInteger(runId) || runId <= 0)
    throw new Error('Missing Judgement runtime credentials');
  const headers = buildWorkerHeaders({
    AUTH_TOKEN: token,
    ROOMOTE_AUTH_BYPASS_VALUE: env.ROOMOTE_AUTH_BYPASS_VALUE,
    ROOMOTE_AUTH_BYPASS_HEADER_NAME: env.ROOMOTE_AUTH_BYPASS_HEADER_NAME,
  });
  const client = createClient({ url, headers: () => headers });
  const shutdown = new AbortController();
  const app = new Hono();
  app.use('*', bodyLimit({ maxSize: MAX_EVIDENCE_BYTES }));
  app.post('/judge', async (c) => {
    if (
      c.req.header('origin') ||
      c.req.header('content-type')?.split(';')[0]?.trim() !== 'application/json'
    )
      return c.json({ error: 'Expected a local JSON request' }, 403);
    let request: JudgeRequest;
    try {
      request = await c.req.json<JudgeRequest>();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    try {
      // The API validates the strict evidence schema and scope. Neither the
      // caller's headers nor a caller-supplied run ID are forwarded.
      const result = await client.taskRuns.evaluateRepositoryJudgement.mutate(
        { runId, request },
        {
          signal: AbortSignal.any([
            shutdown.signal,
            c.req.raw.signal,
            AbortSignal.timeout(3000),
          ]),
        },
      );
      if (result.kind === 'answered') return c.json(result.answer);
      return c.json(
        { error: 'Judgement backend unavailable' },
        result.kind === 'unavailable' ? 503 : 502,
      );
    } catch {
      return c.json({ error: 'Judgement evaluation failed' }, 502);
    }
  });
  const listener = getRequestListener(app.fetch, {
    overrideGlobalObjects: false,
  });
  const server = createServer((request, response) => {
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
    throw new Error('Judgement proxy failed to listen');
  return {
    endpoint: `http://127.0.0.1:${address.port}/judge`,
    close: async () => {
      shutdown.abort();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

export async function setupJudgement(options: {
  runtimeEnv: NodeJS.ProcessEnv;
  logger: Pick<Console, 'warn'>;
  registerCleanup: (close: () => Promise<void>) => void;
}) {
  // Keep this marker even if setup fails: chained repo hooks must not fall
  // back to developer inference when the managed check is unavailable.
  options.runtimeEnv.R_JUDGEMENT_MANAGED = '1';
  delete options.runtimeEnv.R_JUDGEMENT_GATEWAY_URL;
  try {
    const proxy = await startJudgementProxy(options.runtimeEnv);
    options.registerCleanup(proxy.close);
    options.runtimeEnv.R_JUDGEMENT_GATEWAY_URL = proxy.endpoint;
  } catch {
    options.logger.warn(
      '[judgement] Local inference proxy unavailable; repository checks will report incomplete.',
    );
  }
}

export function buildJudgementTerminalEnv(
  userEnv: Record<string, string>,
  runtimeEnv: Record<string, string>,
): Record<string, string> {
  const env = { ...userEnv };
  delete env.ROOMOTE_CLOUD_TOKEN;
  delete env.ROOMOTE_AUTH_BYPASS_HEADER_NAME;
  delete env.ROOMOTE_AUTH_BYPASS_VALUE;
  delete env.R_JUDGEMENT_GATEWAY_URL;
  delete env.R_JUDGEMENT_MANAGED;
  if (runtimeEnv.R_JUDGEMENT_MANAGED === '1') env.R_JUDGEMENT_MANAGED = '1';
  if (runtimeEnv.R_JUDGEMENT_GATEWAY_URL)
    env.R_JUDGEMENT_GATEWAY_URL = runtimeEnv.R_JUDGEMENT_GATEWAY_URL;
  return env;
}
