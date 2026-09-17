import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import {
  authenticateCredentialEgressPrincipal,
  issueSubstitutes,
  registerWorkload,
  renewLease,
  CredentialEgressRequestError,
  terminateWorkload,
  type CredentialEgressPrincipal,
} from '@roomote/sdk/server/credential-egress';

import type { Variables } from '../../types';

/**
 * Credential egress control plane: `/api/internal/credential-egress`.
 *
 * Reachable only by the trusted controller (signed job-auth token with the
 * `roomote-credential-egress-controller` audience). Every other bearer — run
 * tokens, user tokens, MCP tokens, session-broker tokens — is rejected here
 * regardless of what `tokenAuthMiddleware` resolved. Route policy classifies
 * the prefix as `webhook` for exactly that reason: this handler owns
 * authentication.
 *
 * The contract is documented in ./CONTRACT.md next to this file; the schemas
 * live in `@roomote/types` (`credential-egress.ts`). Substitutes are used
 * through the API-side proxy (`../credential-egress-proxy`), which authorizes
 * them in-process; there is no external gateway.
 *
 * Nothing in a request or response body is ever logged: registration
 * responses carry substitute tokens.
 */

const LOG_PREFIX = '[credential-egress]';

type Env = {
  Variables: Variables & { egressPrincipal: CredentialEgressPrincipal };
};

export function createCredentialEgressControlPlane() {
  const app = new Hono<Env>();

  app.use(
    '*',
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => c.json({ error: 'payload_too_large' }, 413),
    }),
  );

  app.use('*', async (c, next) => {
    const principal = await authenticateCredentialEgressPrincipal(
      c.req.header('authorization'),
    );
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    c.set('egressPrincipal', principal);
    await next();
  });

  /** JSON body; an absent/empty body is `{}` so optional payloads stay optional. */
  async function json(c: { req: { text: () => Promise<string> } }) {
    const text = await c.req.text();
    if (!text.trim()) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new CredentialEgressRequestError(400, 'malformed');
    }
  }

  app.onError((error, c) => {
    if (error instanceof CredentialEgressRequestError)
      return c.json({ error: error.code }, error.status);
    // Never include error messages: database errors can echo bound values.
    console.error(
      `${LOG_PREFIX} ${c.req.method} ${c.req.routePath} failed (${error instanceof Error ? error.name : 'Error'})`,
    );
    return c.json({ error: 'internal_error' }, 500);
  });

  // Register an attached run (or rotate its generation).
  app.post('/workloads', async (c) =>
    c.json(await registerWorkload(await json(c)), 201),
  );
  // Substitutes for grants approved after registration.
  app.post('/workloads/:workloadId/substitutes', async (c) =>
    c.json(await issueSubstitutes(c.req.param('workloadId'))),
  );
  // Extend the lease while the run is alive.
  app.post('/workloads/:workloadId/lease', async (c) =>
    c.json(await renewLease(c.req.param('workloadId'), await json(c))),
  );
  // Stop, failure, resume, cleanup. Idempotent.
  app.delete('/workloads/:workloadId', async (c) =>
    c.json(await terminateWorkload(c.req.param('workloadId'), await json(c))),
  );

  return app;
}

export const credentialEgress = createCredentialEgressControlPlane();
