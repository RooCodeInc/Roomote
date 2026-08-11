import { Hono } from 'hono';

import { getRoomoteMcpResourceUrl, ROOMOTE_MCP_SCOPE } from '@roomote/auth';
import { Env } from '@roomote/env';

import type { Variables } from '../types';

const ROOMOTE_MCP_PROTECTED_RESOURCE_METADATA_PATH =
  '/.well-known/oauth-protected-resource/api/mcp-routing/roomote';

export const mcpOAuthMetadata = new Hono<{ Variables: Variables }>();

mcpOAuthMetadata.get(ROOMOTE_MCP_PROTECTED_RESOURCE_METADATA_PATH, (c) => {
  const authorizationServer = Env.R_PUBLIC_URL ?? Env.R_APP_URL;

  c.header('Cache-Control', 'public, max-age=3600');
  return c.json({
    resource: getRoomoteMcpResourceUrl(Env.TRPC_URL),
    authorization_servers: [new URL(authorizationServer).origin],
    bearer_methods_supported: ['header'],
    scopes_supported: [ROOMOTE_MCP_SCOPE],
  });
});
