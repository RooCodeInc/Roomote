import { Hono, type Context } from 'hono';

import {
  getRoomoteMcpResourceUrl,
  ROOMOTE_MCP_PROTECTED_RESOURCE_METADATA_PATH,
  ROOMOTE_MCP_SCOPE,
} from '@roomote/auth';
import { Env } from '@roomote/env';

import type { Variables } from '../types';

const LEGACY_ROOMOTE_MCP_PROTECTED_RESOURCE_METADATA_PATH =
  '/.well-known/oauth-protected-resource/api/mcp-routing/roomote';

export const mcpOAuthMetadata = new Hono<{ Variables: Variables }>();

const protectedResourceMetadataHandler = (
  c: Context<{ Variables: Variables }>,
) => {
  const authorizationServer = Env.R_PUBLIC_URL ?? Env.R_APP_URL;

  c.header('Cache-Control', 'public, max-age=3600');
  return c.json({
    resource: getRoomoteMcpResourceUrl(authorizationServer),
    authorization_servers: [new URL(authorizationServer).origin],
    bearer_methods_supported: ['header'],
    scopes_supported: [ROOMOTE_MCP_SCOPE],
  });
};

mcpOAuthMetadata.get(
  ROOMOTE_MCP_PROTECTED_RESOURCE_METADATA_PATH,
  protectedResourceMetadataHandler,
);
mcpOAuthMetadata.get(
  LEGACY_ROOMOTE_MCP_PROTECTED_RESOURCE_METADATA_PATH,
  protectedResourceMetadataHandler,
);
