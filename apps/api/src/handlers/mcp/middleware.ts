import { createMiddleware } from 'hono/factory';

import type { AuthTokenContext, RunTokenContext } from '@roomote/types';

import type { Variables } from '../../types';
import {
  assertTaskRunTokenTargetExists,
  McpProxyError,
  resolveTaskOrSessionUserIdOrNull,
} from './proxy-utils';

export interface McpAuth {
  userId: string | undefined;
  authContext: AuthTokenContext | RunTokenContext;
}

export async function resolveMcpTaskOrSessionUserId(
  auth: McpAuth,
): Promise<string | undefined> {
  if (auth.authContext.tokenType !== 'run') {
    return auth.userId;
  }

  return (
    (await resolveTaskOrSessionUserIdOrNull(auth.authContext)) ?? undefined
  );
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
    'userId' in authContext ? (authContext.userId ?? undefined) : undefined;

  c.set('mcpAuth', { userId, authContext });

  await next();
});

/** Rejects inactive run tokens before they reach a native MCP handler. */
export const activeRunMcpAuthMiddleware = createMiddleware<{
  Variables: McpVariables;
}>(async (c, next) => {
  const { authContext } = c.get('mcpAuth');

  if (authContext.tokenType === 'run') {
    try {
      await assertTaskRunTokenTargetExists(authContext);
    } catch (error) {
      if (error instanceof McpProxyError) {
        return Response.json(
          { error: error.message },
          { status: error.httpStatus },
        );
      }
      throw error;
    }
  }

  await next();
});
