import { createMiddleware } from 'hono/factory';

import type {
  AuthTokenContext,
  AutomationTokenContext,
  RunTokenContext,
} from '@roomote/types';
import { getActiveAutomationRunForPrincipal } from '@roomote/db/server';

import type { Variables } from '../../types';

export interface McpAuth {
  userId: string | undefined;
  authContext: AuthTokenContext | AutomationTokenContext | RunTokenContext;
}

type McpVariables = Variables & { mcpAuth: McpAuth };

/**
 * Hono middleware that validates auth context.
 * Applied once on the `/api/mcp` route group so handlers can access
 * validated auth via `c.get('mcpAuth')`.
 */
export const mcpAuthMiddleware = createMiddleware<{
  Variables: McpVariables;
}>(async (c, next) => {
  const authContext = c.get('authContext') as
    | AuthTokenContext
    | AutomationTokenContext
    | RunTokenContext
    | undefined;

  if (!authContext) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  if (authContext.tokenType === 'automation') {
    const run = await getActiveAutomationRunForPrincipal({
      automationRunId: authContext.automationRunId,
      leaseOwner: authContext.leaseOwner,
      policyVersion: authContext.policyVersion,
    });
    if (!run) {
      return c.json({ error: 'Automation run token is no longer active' }, 403);
    }
  }

  // Run tokens minted for the deployment service principal carry a null
  // userId; surface that as undefined rather than pretending a user exists.
  const userId =
    'userId' in authContext ? (authContext.userId ?? undefined) : undefined;

  c.set('mcpAuth', { userId, authContext });

  await next();
});
