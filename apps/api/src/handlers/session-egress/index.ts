import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';

import {
  authenticateSessionEgressPrincipal,
  authorize,
  getSessionEgressGatewayToken,
  issueSubstitutes,
  registerWorkload,
  renewLease,
  revocations,
  SessionEgressRequestError,
  terminateWorkload,
  type SessionEgressPrincipal,
  type SessionEgressServiceOptions,
} from '@roomote/sdk/server/session-egress';

import type { Variables } from '../../types';

/**
 * Session egress control plane: `/api/internal/session-egress`.
 *
 * Reachable only by the trusted controller (signed job-auth token with the
 * `roomote-session-egress-controller` audience) and the credential
 * substituting egress gateway (`R_SESSION_EGRESS_GATEWAY_TOKEN`). Every
 * other bearer — run tokens, user tokens, MCP tokens, session-broker
 * tokens — is rejected here regardless of what `tokenAuthMiddleware`
 * resolved. Route policy classifies the prefix as `webhook` for exactly that
 * reason: this handler owns authentication.
 *
 * The contract, including payloads and gateway obligations, is documented in
 * ./CONTRACT.md next to this file; the schemas live in
 * `@roomote/types` (`session-egress.ts`).
 *
 * Nothing in a request or response body is ever logged: bodies carry
 * substitute tokens (requests) and real credentials (authorize responses).
 */

const LOG_PREFIX = '[session-egress]';

type Env = {
  Variables: Variables & { egressPrincipal: SessionEgressPrincipal };
};

export function createSessionEgressControlPlane(
  options: SessionEgressServiceOptions = {},
) {
  const gatewayToken = options.gatewayToken ?? getSessionEgressGatewayToken;
  const app = new Hono<Env>();

  app.use(
    '*',
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => c.json({ error: 'payload_too_large' }, 413),
    }),
  );

  app.use('*', async (c, next) => {
    const expected = gatewayToken();
    if (!expected) return c.json({ error: 'not_found' }, 404);
    const principal = await authenticateSessionEgressPrincipal(
      c.req.header('authorization'),
      expected,
    );
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    c.set('egressPrincipal', principal);
    await next();
  });

  const requirePrincipal = (principal: SessionEgressPrincipal) =>
    createMiddleware<Env>(async (c, next) => {
      if (c.get('egressPrincipal') !== principal)
        return c.json({ error: 'forbidden_principal' }, 403);
      await next();
    });

  const controllerOnly = requirePrincipal('controller');
  const gatewayOnly = requirePrincipal('gateway');

  /** JSON body; an absent/empty body is `{}` so optional payloads stay optional. */
  async function json(c: { req: { text: () => Promise<string> } }) {
    const text = await c.req.text();
    if (!text.trim()) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new SessionEgressRequestError(400, 'malformed');
    }
  }

  app.onError((error, c) => {
    if (error instanceof SessionEgressRequestError)
      return c.json({ error: error.code }, error.status);
    // Never include error messages: database errors can echo bound values.
    console.error(
      `${LOG_PREFIX} ${c.req.method} ${c.req.routePath} failed (${error instanceof Error ? error.name : 'Error'})`,
    );
    return c.json({ error: 'internal_error' }, 500);
  });

  // Controller: bind an attached run to the gateway (or rotate its generation).
  app.post('/workloads', controllerOnly, async (c) =>
    c.json(await registerWorkload(await json(c)), 201),
  );
  // Controller: substitutes for grants approved after registration.
  app.post('/workloads/:workloadId/substitutes', controllerOnly, async (c) =>
    c.json(await issueSubstitutes(c.req.param('workloadId'))),
  );
  // Controller: extend the lease while the run is alive.
  app.post('/workloads/:workloadId/lease', controllerOnly, async (c) =>
    c.json(await renewLease(c.req.param('workloadId'), await json(c))),
  );
  // Controller: stop, failure, resume, cleanup. Idempotent.
  app.delete('/workloads/:workloadId', controllerOnly, async (c) =>
    c.json(await terminateWorkload(c.req.param('workloadId'), await json(c))),
  );

  // Gateway: live per-request / per-phase authorization + credential resolution.
  app.post('/authorize', gatewayOnly, async (c) => {
    let body: unknown;
    try {
      body = await json(c);
    } catch {
      body = undefined;
    }
    return c.json(await authorize(body), 200, { 'cache-control': 'no-store' });
  });
  // Gateway: revocation acceleration feed.
  app.get('/revocations', gatewayOnly, async (c) =>
    c.json(await revocations(c.req.query()), 200, {
      'cache-control': 'no-store',
    }),
  );

  return app;
}

export const sessionEgress = createSessionEgressControlPlane();
