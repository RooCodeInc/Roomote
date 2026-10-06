import { getRoomoteMcpResourceUrl, ROOMOTE_MCP_SCOPE } from '@roomote/auth';
import { Env } from '@roomote/env';
import { isUserToken, PRODUCT_NAME } from '@roomote/types';

import type { Variables } from '../../types';
import type { McpAuth } from './middleware';
import { McpProxyError } from './proxy-utils';

/** Public member reads and downloads share the /mcp credential boundary. */
export function resolveRoomoteMemberAuth(
  auth: Variables['authContext'],
): McpAuth & { userId: string } {
  if (!auth) throw new McpProxyError(401, 'Authentication required');
  if (auth.tokenType === 'run') {
    throw new McpProxyError(
      403,
      'Forbidden: member tools require a user-scoped access token',
    );
  }
  if (isUserToken(auth)) return { userId: auth.userId, authContext: auth };
  if (
    auth.tokenType === 'mcp' &&
    auth.resource ===
      getRoomoteMcpResourceUrl(Env.R_PUBLIC_URL ?? Env.R_APP_URL) &&
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
