import type { Context } from 'hono';
import {
  getLegacyRoomoteMcpResourceUrl,
  getRoomoteMcpResourceUrl,
  ROOMOTE_MCP_SCOPE,
} from '@roomote/auth';
import { Env } from '@roomote/env';
import { isUserToken, PRODUCT_NAME } from '@roomote/types';

import type { Variables } from '../../types';
import { getRequestAuth } from '../../middleware/tokenAuthMiddleware';
import type { McpAuth } from './middleware';
import { McpProxyError } from './proxy-utils';

/** Public member reads and downloads share the /mcp credential boundary. */
export async function resolveRoomoteMemberAuth(
  c: Context<{ Variables: Variables }>,
  options: { allowLegacyAudience?: boolean } = {},
): Promise<McpAuth & { userId: string }> {
  const auth = c.get('authContext');
  if (!auth) throw new McpProxyError(401, 'Authentication required');
  if (auth.tokenType === 'run') {
    throw new McpProxyError(
      403,
      'Forbidden: member tools require a user-scoped access token',
    );
  }
  if (isUserToken(auth)) return { userId: auth.userId, authContext: auth };
  // Internal in-process calls retain user/run semantics, but an OAuth object
  // alone is not proof of live-grant authentication for this HTTP request.
  if (getRequestAuth(c) !== auth)
    throw new McpProxyError(401, 'Authentication required');
  if (
    auth.tokenType === 'mcp' &&
    [
      getRoomoteMcpResourceUrl(Env.R_PUBLIC_URL ?? Env.R_APP_URL),
      ...(options.allowLegacyAudience
        ? [getLegacyRoomoteMcpResourceUrl(Env.TRPC_URL)]
        : []),
    ].includes(auth.resource) &&
    auth.scopes.includes(ROOMOTE_MCP_SCOPE)
  ) {
    return {
      userId: auth.userId,
      authContext: {
        userId: auth.userId,
        tokenType: 'auth',
        version: auth.version,
      },
    };
  }
  throw new McpProxyError(
    403,
    `${PRODUCT_NAME} MCP requires a user-scoped auth token or task run token`,
  );
}
