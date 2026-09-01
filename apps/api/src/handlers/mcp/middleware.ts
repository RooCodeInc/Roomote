import { createMiddleware } from 'hono/factory';

import type { AuthTokenContext, RunTokenContext } from '@roomote/types';

import type { Variables } from '../../types';
import { resolveActingUserIdOrNull } from './proxy-utils';

export interface McpAuth {
  userId: string | undefined;
  authContext: AuthTokenContext | RunTokenContext;
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
    | RunTokenContext
    | undefined;

  if (!authContext) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const userId =
    authContext.tokenType === 'run'
      ? ((await resolveActingUserIdOrNull(authContext)) ?? undefined)
      : authContext.userId;

  c.set('mcpAuth', { userId, authContext });

  await next();
});
