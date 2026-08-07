import { db, eq, customMcpServers } from '@roomote/db/server';
import { decrypt } from '@roomote/db/encryption';
import { Env } from '@roomote/env';
import {
  customMcpServerIdFromConnectionId,
  type OAuthClientInformation,
  type OAuthServerMetadata,
} from '@roomote/types';

import { createGuardedFetch } from '../safe-fetch';
import { discoverOAuthEndpoints, type OAuthRequestOptions } from './oauth';

/**
 * OAuth context for a deployment custom MCP server, resolved from its
 * `custom:<serverId>` connection id.
 *
 * Everything here differs from the catalog path on purpose:
 * - The server URL comes from the database row, not MCP_INTEGRATIONS.
 * - Every protocol fetch goes through the SSRF-guarded fetch, because both
 *   the operator URL and the discovery chain (WWW-Authenticate hints,
 *   authorization_servers lists) are untrusted.
 * - Discovered AS metadata is persisted on the row and pinned: refreshes use
 *   the stored token_endpoint rather than re-discovering per refresh, which
 *   also prevents a custom URL that equals a catalog URL from picking up the
 *   catalog's pinned endpoints.
 * - Manual client credentials (for servers without dynamic registration)
 *   take precedence over stored DCR clients.
 */
export interface CustomMcpAuthTarget {
  serverId: string;
  name: string;
  url: string;
  serverMetadata: OAuthServerMetadata | null;
  manualClient: OAuthClientInformation | null;
  oauthOptions: OAuthRequestOptions;
}

export async function resolveCustomMcpAuthTarget(
  mcpId: string,
): Promise<CustomMcpAuthTarget | null> {
  const serverId = customMcpServerIdFromConnectionId(mcpId);

  if (!serverId) {
    return null;
  }

  const server = await db.query.customMcpServers.findFirst({
    where: eq(customMcpServers.id, serverId),
  });

  if (!server?.url || server.authType !== 'oauth') {
    return null;
  }

  return {
    serverId,
    name: server.name,
    url: server.url,
    serverMetadata: server.oauthServerMetadata ?? null,
    manualClient: server.manualClientId
      ? {
          client_id: server.manualClientId,
          client_secret: server.manualClientSecret
            ? decrypt(server.manualClientSecret)
            : undefined,
          token_endpoint_auth_method: server.manualClientSecret
            ? 'client_secret_post'
            : 'none',
        }
      : null,
    oauthOptions: {
      fetchImpl: createGuardedFetch(Env.R_CUSTOM_MCP_ALLOWED_PRIVATE_CIDRS),
      ...(server.oauthResourceIndicatorDisabled
        ? {}
        : { resource: server.url }),
    },
  };
}

/**
 * The pinned AS metadata for a custom server, discovering and persisting it
 * on first use. Re-discovery happens only when nothing is stored — a
 * Reconnect clears the stored copy (the update command resets it whenever
 * the URL or auth mode changes).
 */
export async function ensureCustomMcpServerMetadata(
  target: CustomMcpAuthTarget,
): Promise<OAuthServerMetadata> {
  if (target.serverMetadata) {
    return target.serverMetadata;
  }

  const metadata = await discoverOAuthEndpoints(
    target.url,
    target.oauthOptions,
  );

  await db
    .update(customMcpServers)
    .set({
      oauthServerMetadata: metadata,
      oauthServerMetadataFetchedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(customMcpServers.id, target.serverId));

  return metadata;
}

/**
 * True when a token-endpoint failure means the grant itself is dead
 * (revoked, expired beyond recovery, or the client is no longer valid), as
 * opposed to a transient outage where retrying with the stale token is the
 * kinder behavior.
 */
export function isDefinitiveOAuthRejection(message: string): boolean {
  return /invalid_grant|invalid_client/i.test(message);
}
