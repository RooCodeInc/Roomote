import {
  and,
  customMcpServers,
  db,
  eq,
  isNull,
  mcpConnections,
  personalMcpServers,
  users,
} from '@roomote/db/server';
import {
  customMcpConnectionId,
  type CustomMcpServerAuthType,
  type OAuthServerMetadata,
} from '@roomote/types';

/**
 * A custom MCP server from either table, in one shape. `ownerUserId` is the
 * whole ownership story: null means a deployment server every member shares,
 * a user id means a personal server only that member may reach. Callers that
 * resolve credentials must check it; nothing here does that for them.
 */
export interface ResolvedCustomMcpServer {
  id: string;
  ownerUserId: string | null;
  /**
   * Who added it. For a deployment server this is the member who may manage
   * it alongside administrators; null once that member is removed.
   */
  createdByUserId: string | null;
  name: string;
  /** Null only for deployment stdio servers. */
  url: string | null;
  isStdio: boolean;
  authType: CustomMcpServerAuthType;
  headers: Record<string, string> | null;
  disabledTools: string[] | null;
  manualClientId: string | null;
  manualClientSecret: string | null;
  oauthServerMetadata: OAuthServerMetadata | null;
  oauthResourceIndicatorDisabled: boolean;
  enabled: boolean;
  updatedAt: Date;
}

/**
 * Look a server up by id in the deployment table, then the personal one. A
 * personal server whose owner has been deactivated is treated as gone, the
 * same rule personal integration keys follow.
 */
export async function findCustomMcpServerById(
  id: string,
): Promise<ResolvedCustomMcpServer | null> {
  const deployment = await db.query.customMcpServers.findFirst({
    where: eq(customMcpServers.id, id),
  });
  if (deployment) {
    return {
      id: deployment.id,
      ownerUserId: null,
      createdByUserId: deployment.createdByUserId,
      name: deployment.name,
      url: deployment.url,
      isStdio: Boolean(deployment.stdio),
      authType: deployment.authType,
      headers: deployment.headers ?? null,
      disabledTools: deployment.disabledTools ?? null,
      manualClientId: deployment.manualClientId,
      manualClientSecret: deployment.manualClientSecret,
      oauthServerMetadata: deployment.oauthServerMetadata ?? null,
      oauthResourceIndicatorDisabled: deployment.oauthResourceIndicatorDisabled,
      enabled: deployment.enabled,
      updatedAt: deployment.updatedAt,
    };
  }

  const [personal] = await db
    .select({ server: personalMcpServers })
    .from(personalMcpServers)
    .innerJoin(users, eq(users.id, personalMcpServers.ownerUserId))
    .where(and(eq(personalMcpServers.id, id), isNull(users.deletedAt)))
    .limit(1);
  if (!personal) return null;

  const { server } = personal;
  return {
    id: server.id,
    ownerUserId: server.ownerUserId,
    createdByUserId: server.ownerUserId,
    name: server.name,
    url: server.url,
    isStdio: false,
    authType: server.authType,
    headers: server.headers ?? null,
    disabledTools: server.disabledTools ?? null,
    manualClientId: server.manualClientId,
    manualClientSecret: server.manualClientSecret,
    oauthServerMetadata: server.oauthServerMetadata ?? null,
    oauthResourceIndicatorDisabled: server.oauthResourceIndicatorDisabled,
    enabled: server.enabled,
    updatedAt: server.updatedAt,
  };
}

/**
 * The OAuth connection that belongs to a server: deployment-scoped (no user)
 * for a deployment server, the owner's own row for a personal one. Using
 * this everywhere is what keeps one member's tokens out of another's calls.
 */
export function customMcpConnectionWhere(server: {
  id: string;
  ownerUserId: string | null;
}) {
  return and(
    eq(mcpConnections.mcpId, customMcpConnectionId(server.id)),
    server.ownerUserId
      ? eq(mcpConnections.userId, server.ownerUserId)
      : isNull(mcpConnections.userId),
  );
}

/** Persist discovered authorization-server metadata on whichever row owns it. */
export async function storeCustomMcpServerMetadata(
  server: { id: string; ownerUserId: string | null },
  metadata: OAuthServerMetadata,
): Promise<void> {
  const set = {
    oauthServerMetadata: metadata,
    oauthServerMetadataFetchedAt: new Date(),
    updatedAt: new Date(),
  };
  if (server.ownerUserId) {
    await db
      .update(personalMcpServers)
      .set(set)
      .where(eq(personalMcpServers.id, server.id));
    return;
  }
  await db
    .update(customMcpServers)
    .set(set)
    .where(eq(customMcpServers.id, server.id));
}

/**
 * Who may manage or authorize a custom server, mirroring integration keys:
 * a personal server belongs to its owner alone; a deployment server is
 * managed by administrators and by the member who added it.
 */
export function canManageCustomMcpServer(
  server: { ownerUserId: string | null; createdByUserId: string | null },
  actor: { userId: string; isAdmin: boolean },
): boolean {
  if (server.ownerUserId) return server.ownerUserId === actor.userId;
  return actor.isAdmin || server.createdByUserId === actor.userId;
}
