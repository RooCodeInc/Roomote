import { createMiddleware } from 'hono/factory';

import type { AuthTokenContext, JobTokenContext } from '@roomote/types';

import type { Variables } from '../../types';

export interface McpAuth {
  userId: string | undefined;
  authContext: AuthTokenContext | JobTokenContext;
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
    | JobTokenContext
    | undefined;

  if (!authContext) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const userId =
    'userId' in authContext ? (authContext.userId as string) : undefined;

  c.set('mcpAuth', { userId, authContext });

  await next();
});
