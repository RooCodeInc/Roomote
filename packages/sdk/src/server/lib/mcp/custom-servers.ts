import {
  and,
  count,
  customMcpServers,
  db,
  eq,
  isNull,
  mcpConnections,
  personalMcpServers,
  users,
  type DatabaseOrTransaction,
} from '@roomote/db/server';
import {
  MAX_CUSTOM_MCP_SERVERS,
  MAX_PERSONAL_MCP_SERVERS,
  customMcpConnectionId,
  type CustomMcpServerAuthType,
  type CustomMcpServerStdioConfig,
  type CustomMcpServerVisibility,
  type OAuthServerMetadata,
} from '@roomote/types';

export type CustomMcpServerScope =
  | { visibility: 'deployment' }
  | { visibility: 'owner'; ownerUserId: string };

/** One persistence-facing shape for rows stored in either custom MCP table. */
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
  stdio: CustomMcpServerStdioConfig | null;
  isStdio: boolean;
  authType: CustomMcpServerAuthType;
  headers: Record<string, string> | null;
  disabledTools: string[] | null;
  manualClientId: string | null;
  manualClientSecret: string | null;
  oauthServerMetadata: OAuthServerMetadata | null;
  oauthServerMetadataFetchedAt: Date | null;
  oauthResourceIndicatorDisabled: boolean;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type CustomMcpServerWrite = {
  id?: string;
  name: string;
  url: string | null;
  stdio?: CustomMcpServerStdioConfig | null;
  authType: CustomMcpServerAuthType;
  headers?: Record<string, string> | null;
  disabledTools?: string[] | null;
  manualClientId?: string | null;
  manualClientSecret?: string | null;
  oauthServerMetadata?: OAuthServerMetadata | null;
  oauthServerMetadataFetchedAt?: Date | null;
  oauthResourceIndicatorDisabled?: boolean;
  enabled?: boolean;
  createdByUserId: string;
};

export type CustomMcpServerUpdate = Partial<
  Pick<
    CustomMcpServerWrite,
    | 'url'
    | 'stdio'
    | 'authType'
    | 'headers'
    | 'disabledTools'
    | 'manualClientId'
    | 'manualClientSecret'
    | 'oauthServerMetadata'
    | 'oauthServerMetadataFetchedAt'
    | 'oauthResourceIndicatorDisabled'
    | 'enabled'
  >
> & { updatedAt?: Date };

function resolveDeploymentRow(
  row: typeof customMcpServers.$inferSelect,
): ResolvedCustomMcpServer {
  return {
    id: row.id,
    ownerUserId: null,
    createdByUserId: row.createdByUserId,
    name: row.name,
    url: row.url,
    stdio: row.stdio ?? null,
    isStdio: Boolean(row.stdio),
    authType: row.authType,
    headers: row.headers ?? null,
    disabledTools: row.disabledTools ?? null,
    manualClientId: row.manualClientId,
    manualClientSecret: row.manualClientSecret,
    oauthServerMetadata: row.oauthServerMetadata ?? null,
    oauthServerMetadataFetchedAt: row.oauthServerMetadataFetchedAt,
    oauthResourceIndicatorDisabled: row.oauthResourceIndicatorDisabled,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function resolvePersonalRow(
  row: typeof personalMcpServers.$inferSelect,
): ResolvedCustomMcpServer {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    createdByUserId: row.ownerUserId,
    name: row.name,
    url: row.url,
    stdio: null,
    isStdio: false,
    authType: row.authType,
    headers: row.headers ?? null,
    disabledTools: row.disabledTools ?? null,
    manualClientId: row.manualClientId,
    manualClientSecret: row.manualClientSecret,
    oauthServerMetadata: row.oauthServerMetadata ?? null,
    oauthServerMetadataFetchedAt: row.oauthServerMetadataFetchedAt,
    oauthResourceIndicatorDisabled: row.oauthResourceIndicatorDisabled,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The scoped persistence boundary for custom MCP servers. Feature flows choose
 * a product scope once; only this module chooses the physical table.
 */
export function customMcpServerStore(
  scope: CustomMcpServerScope,
  client: DatabaseOrTransaction = db,
) {
  return {
    scope,

    async list(options: { enabledOnly?: boolean } = {}) {
      if (scope.visibility === 'owner') {
        const rows = await client.query.personalMcpServers.findMany({
          where: options.enabledOnly
            ? and(
                eq(personalMcpServers.ownerUserId, scope.ownerUserId),
                eq(personalMcpServers.enabled, true),
              )
            : eq(personalMcpServers.ownerUserId, scope.ownerUserId),
          orderBy: (table, { asc }) => [asc(table.name)],
        });
        return rows.map(resolvePersonalRow);
      }

      const rows = await client.query.customMcpServers.findMany({
        where: options.enabledOnly
          ? eq(customMcpServers.enabled, true)
          : undefined,
        orderBy: (table, { asc }) => [asc(table.name)],
      });
      return rows.map(resolveDeploymentRow);
    },

    async count() {
      const [row] =
        scope.visibility === 'owner'
          ? await client
              .select({ value: count() })
              .from(personalMcpServers)
              .where(eq(personalMcpServers.ownerUserId, scope.ownerUserId))
          : await client.select({ value: count() }).from(customMcpServers);
      return row?.value ?? 0;
    },

    async create(input: CustomMcpServerWrite): Promise<{ id: string } | null> {
      if (scope.visibility === 'owner') {
        if (!input.url || input.stdio) {
          throw new Error('Personal MCP servers must be remote.');
        }
        const [created] = await client
          .insert(personalMcpServers)
          .values({
            id: input.id,
            ownerUserId: scope.ownerUserId,
            name: input.name,
            url: input.url,
            authType: input.authType,
            headers: input.headers,
            disabledTools: input.disabledTools,
            manualClientId: input.manualClientId,
            manualClientSecret: input.manualClientSecret,
            oauthServerMetadata: input.oauthServerMetadata,
            oauthServerMetadataFetchedAt: input.oauthServerMetadataFetchedAt,
            oauthResourceIndicatorDisabled:
              input.oauthResourceIndicatorDisabled,
            enabled: input.enabled,
          })
          .onConflictDoNothing({
            target: [personalMcpServers.ownerUserId, personalMcpServers.name],
          })
          .returning({ id: personalMcpServers.id });
        return created ?? null;
      }

      if (Boolean(input.url) === Boolean(input.stdio)) {
        throw new Error(
          'Deployment MCP servers must configure exactly one transport.',
        );
      }
      const [created] = await client
        .insert(customMcpServers)
        .values({
          id: input.id,
          name: input.name,
          url: input.url,
          stdio: input.stdio,
          authType: input.authType,
          headers: input.headers,
          disabledTools: input.disabledTools,
          manualClientId: input.manualClientId,
          manualClientSecret: input.manualClientSecret,
          oauthServerMetadata: input.oauthServerMetadata,
          oauthServerMetadataFetchedAt: input.oauthServerMetadataFetchedAt,
          oauthResourceIndicatorDisabled: input.oauthResourceIndicatorDisabled,
          enabled: input.enabled,
          createdByUserId: input.createdByUserId,
        })
        .onConflictDoNothing({ target: [customMcpServers.name] })
        .returning({ id: customMcpServers.id });
      return created ?? null;
    },
  };
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
  if (deployment) return resolveDeploymentRow(deployment);

  const [personal] = await db
    .select({ server: personalMcpServers })
    .from(personalMcpServers)
    .innerJoin(users, eq(users.id, personalMcpServers.ownerUserId))
    .where(and(eq(personalMcpServers.id, id), isNull(users.deletedAt)))
    .limit(1);
  return personal ? resolvePersonalRow(personal.server) : null;
}

/** The OAuth connection owned by a resolved server. */
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

export async function updateCustomMcpServer(
  server: Pick<ResolvedCustomMcpServer, 'id' | 'ownerUserId'>,
  changes: CustomMcpServerUpdate,
  client: DatabaseOrTransaction = db,
): Promise<void> {
  if (server.ownerUserId) {
    const { stdio: _stdio, url, ...personalChanges } = changes;
    if (url === null || _stdio) {
      throw new Error('Personal MCP servers must be remote.');
    }
    await client
      .update(personalMcpServers)
      .set({
        ...personalChanges,
        ...(url === undefined ? {} : { url }),
      })
      .where(eq(personalMcpServers.id, server.id));
    return;
  }
  await client
    .update(customMcpServers)
    .set(changes)
    .where(eq(customMcpServers.id, server.id));
}

export async function deleteCustomMcpServer(
  server: Pick<ResolvedCustomMcpServer, 'id' | 'ownerUserId'>,
  client: DatabaseOrTransaction = db,
): Promise<void> {
  if (server.ownerUserId) {
    await client
      .delete(personalMcpServers)
      .where(eq(personalMcpServers.id, server.id));
    return;
  }
  await client
    .delete(customMcpServers)
    .where(eq(customMcpServers.id, server.id));
}

/** Persist discovered authorization-server metadata on the resolved row. */
export async function storeCustomMcpServerMetadata(
  server: Pick<ResolvedCustomMcpServer, 'id' | 'ownerUserId'>,
  metadata: OAuthServerMetadata,
): Promise<void> {
  await updateCustomMcpServer(server, {
    oauthServerMetadata: metadata,
    oauthServerMetadataFetchedAt: new Date(),
    updatedAt: new Date(),
  });
}

/**
 * Atomically move a server and its OAuth connection between product scopes.
 * The server id remains stable, preserving its proxy and connection identity.
 */
export async function moveCustomMcpServer(
  server: ResolvedCustomMcpServer,
  visibility: CustomMcpServerVisibility,
): Promise<void> {
  await db.transaction(async (tx) => {
    if (visibility === 'owner') {
      const ownerUserId = server.createdByUserId;
      if (!ownerUserId) {
        throw new Error(
          'This server has no owner to move it to. Remove it and add a personal one instead.',
        );
      }
      if (server.isStdio || !server.url) {
        throw new Error('Local (stdio) servers cannot be personal.');
      }
      const target = customMcpServerStore(
        { visibility: 'owner', ownerUserId },
        tx,
      );
      if ((await target.count()) >= MAX_PERSONAL_MCP_SERVERS) {
        throw new Error(
          `At most ${MAX_PERSONAL_MCP_SERVERS} personal MCP servers are supported.`,
        );
      }
      const moved = await target.create({
        ...server,
        createdByUserId: ownerUserId,
      });
      if (!moved) {
        throw new Error(
          `Its owner already has a personal MCP server named '${server.name}'.`,
        );
      }
      await tx
        .update(mcpConnections)
        .set({ userId: ownerUserId, updatedAt: new Date() })
        .where(customMcpConnectionWhere(server));
      await deleteCustomMcpServer(server, tx);
      return;
    }

    const ownerUserId = server.ownerUserId;
    if (!ownerUserId) return;
    const target = customMcpServerStore({ visibility: 'deployment' }, tx);
    if ((await target.count()) >= MAX_CUSTOM_MCP_SERVERS) {
      throw new Error(
        `At most ${MAX_CUSTOM_MCP_SERVERS} custom MCP servers are supported.`,
      );
    }
    const moved = await target.create({
      ...server,
      createdByUserId: ownerUserId,
    });
    if (!moved) {
      throw new Error(
        `A shared MCP server named '${server.name}' already exists.`,
      );
    }
    await tx
      .update(mcpConnections)
      .set({ userId: null, updatedAt: new Date() })
      .where(customMcpConnectionWhere(server));
    await deleteCustomMcpServer(server, tx);
  });
}

/**
 * A personal server belongs to its owner alone; a deployment server is
 * managed by administrators and by the member who added it.
 */
export function canManageCustomMcpServer(
  server: { ownerUserId: string | null; createdByUserId: string | null },
  actor: { userId: string; isAdmin: boolean },
): boolean {
  if (server.ownerUserId) return server.ownerUserId === actor.userId;
  return actor.isAdmin || server.createdByUserId === actor.userId;
}
