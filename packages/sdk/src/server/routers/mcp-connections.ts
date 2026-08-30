import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { ROOMOTE_MCP_PATH } from '@roomote/auth';
import {
  Env,
  areCuratedIntegrationsDisabled,
  isCustomMcpDisabled,
} from '@roomote/env';
import {
  db,
  desc,
  mcpConnections,
  deploymentMcpEnablements,
  customMcpServers,
  eq,
  and,
  inArray,
  isBrainEnabled,
  isNull,
  isNotNull,
  or,
} from '@roomote/db/server';
import { decrypt } from '@roomote/db/encryption';
import { getValidAccessToken, hasValidOAuthTokens } from '../lib/mcp/data';
import {
  getMcpIntegrationUpstreamUrl,
  MCP_INTEGRATIONS,
  isMcpConnectionAsanaConfig,
  isMcpConnectionNotionConfig,
  isMcpConnectionGranolaConfig,
  isMcpConnectionGbrainConfig,
  isMcpConnectionGrafanaConfig,
  getMcpIntegration,
  getMcpIntegrationConnectionScope,
  isMcpConnectionOAuthConfig,
  isMcpConnectionSnowflakeConfig,
  isMcpConnectionVercelConfig,
  isMcpConnectionXConfig,
  isDeploymentScopedMcpIntegration,
  BRAIN_MCP_ID,
  BRAIN_PROXY_PATH,
  CUSTOM_MCP_PROXY_PATH_PREFIX,
  MCP_INTEGRATION_PROXY_PATH_PREFIX,
  ROOMOTE_MCP_ID,
  customMcpConnectionId,
  PRODUCT_NAME,
} from '@roomote/types';

import {
  authenticatedProcedure,
  isRunToken,
  userOnlyProcedure,
  router,
} from '../trpc';
import { resolveActorScopedUserContext } from '../lib/auth';

const INTEGRATION_PROXY_MCP_IDS = new Set(
  MCP_INTEGRATIONS.map((integration) => integration.id),
);
const ORGANIZATION_SCOPED_MCP_IDS = MCP_INTEGRATIONS.filter((integration) =>
  isDeploymentScopedMcpIntegration(integration.id),
).map((integration) => integration.id);
const USER_SCOPED_MCP_IDS = MCP_INTEGRATIONS.filter(
  (integration) => !isDeploymentScopedMcpIntegration(integration.id),
).map((integration) => integration.id);

type ResolvedMcpServerConfig = {
  url: string;
  headers: Record<string, string>;
  disabledTools?: string[];
};

type ResolvedMcpServerConfigs = Record<string, ResolvedMcpServerConfig>;

type InfoLogger = (...args: unknown[]) => void;

function buildProxyUrl(mcpId: string, requestOrigin: string | null): string {
  const proxyPath = `${MCP_INTEGRATION_PROXY_PATH_PREFIX}${mcpId}`;
  return requestOrigin ? `${requestOrigin}${proxyPath}` : proxyPath;
}

function getRequestOrigin(req: { url?: string } | undefined): string | null {
  if (!req?.url) {
    return null;
  }

  try {
    return new URL(req.url).origin;
  } catch {
    return null;
  }
}

async function resolveMcpServerConfigs(options: {
  auth: Parameters<typeof resolveActorScopedUserContext>[0];
  requestOrigin: string | null;
  includeRoomoteMemberTools?: boolean;
  quiet?: boolean;
}): Promise<ResolvedMcpServerConfigs> {
  const logInfo: InfoLogger = options.quiet ? () => {} : console.info;
  const servers: ResolvedMcpServerConfigs = {};

  if (!areCuratedIntegrationsDisabled(Env.R_CURATED_INTEGRATIONS_DISABLED)) {
    Object.assign(
      servers,
      await buildCuratedMcpServerConfigs({
        auth: options.auth,
        requestOrigin: options.requestOrigin,
        logInfo,
      }),
    );
  }

  if (!isCustomMcpDisabled(Env.R_CUSTOM_MCP_DISABLED)) {
    const custom = await buildCustomMcpServerConfigs(
      options.requestOrigin,
      logInfo,
    );

    for (const [name, config] of Object.entries(custom)) {
      if (!servers[name]) servers[name] = config;
    }
  }

  if (Env.R_GBRAIN_URL && !servers[BRAIN_MCP_ID] && (await isBrainEnabled())) {
    servers[BRAIN_MCP_ID] = {
      url: `${options.requestOrigin ?? ''}${BRAIN_PROXY_PATH}`,
      headers: {},
    };
  }

  if (options.includeRoomoteMemberTools && !servers[ROOMOTE_MCP_ID]) {
    servers[ROOMOTE_MCP_ID] = {
      url: `${options.requestOrigin ?? ''}${ROOMOTE_MCP_PATH}`,
      headers: {},
    };
  }

  logInfo('[getMcpServerConfigs] Final resolved server keys:', [
    ...Object.keys(servers),
  ]);

  return servers;
}

export async function resolveUserMcpServerConfigs(options: {
  userId: string;
  apiBaseUrl?: string;
  includeRoomoteMemberTools?: boolean;
}): Promise<ResolvedMcpServerConfigs> {
  return resolveMcpServerConfigs({
    auth: { userId: options.userId },
    requestOrigin: getRequestOrigin({ url: options.apiBaseUrl }),
    includeRoomoteMemberTools: options.includeRoomoteMemberTools,
    // This runs on every Fast turn; the per-connection info stream is worker
    // config-fetch debugging noise at that frequency.
    quiet: true,
  });
}

export const mcpConnectionsRouter = router({
  isOrgEnabled: authenticatedProcedure
    .input(
      z.object({
        mcpId: z.string(),
      }),
    )
    .query(async ({ input }) => {
      if (areCuratedIntegrationsDisabled(Env.R_CURATED_INTEGRATIONS_DISABLED)) {
        return false;
      }

      // Deployment-scoped enablement: valid for any authenticated
      // principal, including deployment-service-principal run tokens.
      const enablement = await db.query.deploymentMcpEnablements.findFirst({
        where: and(
          eq(deploymentMcpEnablements.mcpId, input.mcpId),
          eq(deploymentMcpEnablements.enabled, true),
        ),
        columns: {
          mcpId: true,
        },
      });

      return Boolean(enablement);
    }),

  /**
   * Check if a connection has valid OAuth tokens
   */
  hasValidTokens: userOnlyProcedure
    .input(
      z.object({
        id: z.string().uuid(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const viewerUserId =
        'userId' in ctx.auth ? (ctx.auth.userId ?? undefined) : undefined;

      if (!viewerUserId) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'MCP connection lookups require a userId',
        });
      }

      const connection = await db.query.mcpConnections.findFirst({
        where: and(
          eq(mcpConnections.id, input.id),
          or(
            eq(mcpConnections.userId, viewerUserId),
            isNull(mcpConnections.userId),
          ),
        ),
      });

      if (!connection) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'MCP connection not found',
        });
      }

      const hasTokens = await hasValidOAuthTokens(connection.id);

      return { hasValidTokens: hasTokens };
    }),

  /**
   * Get ready-to-use MCP server configs for a cloud agent.
   *
   * Only returns connections whose MCP is enabled at the org level
   * via deploymentMcpEnablements.
   *
   * Handles token refresh server-side — the caller never sees
   * refresh tokens, client secrets, or raw OAuth tokens.
   *
   * Returns a map of sanitized server names to { url, headers }.
   */
  getMcpServerConfigs: authenticatedProcedure.query(async ({ ctx }) => ({
    servers: await resolveMcpServerConfigs({
      auth: ctx.auth,
      requestOrigin: getRequestOrigin(ctx.req),
    }),
  })),

  /**
   * Deployment-scoped custom stdio MCP servers, with decrypted env values.
   *
   * Run-token only: the response contains the secret material the sandbox
   * needs to launch the local process, which a member's plain auth token must
   * not be able to read directly.
   */
  getCustomStdioMcpServers: authenticatedProcedure.query(async ({ ctx }) => {
    if (!isRunToken(ctx.auth)) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Custom stdio MCP configs are only served to run tokens.',
      });
    }

    if (isCustomMcpDisabled(Env.R_CUSTOM_MCP_DISABLED)) {
      return { servers: {} };
    }

    const rows = await db.query.customMcpServers.findMany({
      where: and(
        eq(customMcpServers.enabled, true),
        isNotNull(customMcpServers.stdio),
      ),
    });

    const servers: Record<
      string,
      { command: string; args?: string[]; env?: Record<string, string> }
    > = {};

    for (const row of rows) {
      if (!row.stdio) {
        continue;
      }

      servers[row.name] = {
        command: row.stdio.command,
        ...(row.stdio.args ? { args: row.stdio.args } : {}),
        ...(row.stdio.env
          ? {
              env: Object.fromEntries(
                Object.entries(row.stdio.env).map(([name, value]) => [
                  name,
                  decrypt(value),
                ]),
              ),
            }
          : {}),
      };
    }

    return { servers };
  }),
});

/**
 * Proxy entries for enabled deployment custom remote servers. Secret-free by
 * construction: credentials are injected by the API proxy per request, so
 * this is safe to serve to any authenticated principal and to re-serve on
 * actor refreshes (the entries are actor-independent).
 */
async function buildCustomMcpServerConfigs(
  requestOrigin: string | null,
  logInfo: InfoLogger,
): Promise<ResolvedMcpServerConfigs> {
  const servers: ResolvedMcpServerConfigs = {};

  const rows = await db.query.customMcpServers.findMany({
    where: eq(customMcpServers.enabled, true),
  });

  for (const row of rows) {
    // stdio servers ride the worker merge path via getCustomStdioMcpServers.
    if (row.stdio || !row.url) {
      continue;
    }

    if (row.authType === 'oauth') {
      const connection = await db.query.mcpConnections.findFirst({
        where: and(
          eq(mcpConnections.mcpId, customMcpConnectionId(row.id)),
          isNull(mcpConnections.userId),
        ),
        columns: { authStatus: true },
      });

      if (connection?.authStatus !== 'authenticated') {
        logInfo(
          `[getMcpServerConfigs] Skipping custom server '${row.name}': OAuth connection not authenticated`,
        );
        continue;
      }
    }

    const proxyPath = `${CUSTOM_MCP_PROXY_PATH_PREFIX}${row.id}`;

    servers[row.name] = {
      url: requestOrigin ? `${requestOrigin}${proxyPath}` : proxyPath,
      headers: { 'X-MCP-Client': PRODUCT_NAME },
    };
  }

  return servers;
}

async function buildCuratedMcpServerConfigs(ctx: {
  auth: Parameters<typeof resolveActorScopedUserContext>[0];
  requestOrigin: string | null;
  logInfo: InfoLogger;
}): Promise<ResolvedMcpServerConfigs> {
  const logInfo = ctx.logInfo;
  const actorContext = await resolveActorScopedUserContext(ctx.auth);

  const connectionFilters = [];

  if (actorContext.userId && USER_SCOPED_MCP_IDS.length > 0) {
    connectionFilters.push(
      and(
        eq(mcpConnections.userId, actorContext.userId),
        inArray(mcpConnections.mcpId, USER_SCOPED_MCP_IDS),
      ),
    );
  }

  if (ORGANIZATION_SCOPED_MCP_IDS.length > 0) {
    connectionFilters.push(
      and(
        isNull(mcpConnections.userId),
        inArray(mcpConnections.mcpId, ORGANIZATION_SCOPED_MCP_IDS),
      ),
    );
  }

  if (connectionFilters.length === 0) {
    return {};
  }

  const enabledConnections = await db
    .select({
      enabledMcpId: deploymentMcpEnablements.mcpId,
      disabledTools: deploymentMcpEnablements.disabledTools,
      connection: mcpConnections,
    })
    .from(deploymentMcpEnablements)
    .leftJoin(
      mcpConnections,
      and(
        eq(mcpConnections.mcpId, deploymentMcpEnablements.mcpId),
        eq(mcpConnections.enabled, true),
        or(...connectionFilters),
      ),
    )
    .where(and(eq(deploymentMcpEnablements.enabled, true)))
    .orderBy(desc(mcpConnections.createdAt));

  const enabledMcpIds = new Set(
    enabledConnections.map(({ enabledMcpId }) => enabledMcpId),
  );
  const deploymentScopedEnabledIds = Array.from(enabledMcpIds).filter((mcpId) =>
    isDeploymentScopedMcpIntegration(mcpId),
  );
  const userScopedEnabledIds = Array.from(enabledMcpIds).filter(
    (mcpId) => !isDeploymentScopedMcpIntegration(mcpId),
  );
  const connections = enabledConnections.flatMap(({ connection }) =>
    connection ? [connection] : [],
  );

  logInfo('[getMcpServerConfigs] Enabled MCP IDs found:', [...enabledMcpIds]);
  logInfo('[getMcpServerConfigs] Connection filter counts:', {
    deploymentScopedCount: deploymentScopedEnabledIds.length,
    userScopedCount: actorContext.userId ? userScopedEnabledIds.length : 0,
  });

  const servers: ResolvedMcpServerConfigs = {};
  const requestOrigin = ctx.requestOrigin;

  for (const connection of connections) {
    logInfo('[getMcpServerConfigs] Processing connection:', {
      connectionId: connection.id,
      mcpId: connection.mcpId,
      userId: connection.userId,
    });

    if (!enabledMcpIds.has(connection.mcpId)) {
      logInfo('[getMcpServerConfigs] Skipping connection:', {
        connectionId: connection.id,
        mcpId: connection.mcpId,
        reason: 'mcp_not_enabled',
      });
      continue;
    }

    const integration = getMcpIntegration(connection.mcpId);
    if (!integration) {
      logInfo('[getMcpServerConfigs] Skipping connection:', {
        connectionId: connection.id,
        mcpId: connection.mcpId,
        reason: 'integration_not_found',
      });
      continue;
    }

    // Credential-only integrations (e.g. ElevenLabs narration) are consumed
    // by control-plane features exclusively: no MCP server exists for them
    // and their credentials must never be delivered toward a task sandbox.
    if (integration.serverMode === 'credential_only') {
      logInfo('[getMcpServerConfigs] Skipping connection:', {
        connectionId: connection.id,
        mcpId: connection.mcpId,
        reason: 'credential_only_integration',
      });
      continue;
    }

    const connectionScope = getMcpIntegrationConnectionScope(integration);

    if (connection.mcpId === 'linear') {
      if (!INTEGRATION_PROXY_MCP_IDS.has(connection.mcpId)) {
        continue;
      }

      servers[connection.mcpId] = {
        url: buildProxyUrl(connection.mcpId, requestOrigin),
        headers: {
          'X-MCP-Client': PRODUCT_NAME,
        },
      };
      logInfo('[getMcpServerConfigs] Included connection:', {
        connectionId: connection.id,
        mcpId: connection.mcpId,
        via: 'linear_proxy',
      });
      continue;
    }

    if (
      (connectionScope === 'deployment' && connection.userId !== null) ||
      (connectionScope === 'user' &&
        (!actorContext.userId || connection.userId !== actorContext.userId))
    ) {
      logInfo('[getMcpServerConfigs] Skipping connection:', {
        connectionId: connection.id,
        mcpId: connection.mcpId,
        reason: 'scope_mismatch',
      });
      continue;
    }

    try {
      const headers: Record<string, string> = {
        'X-MCP-Client': PRODUCT_NAME,
      };

      const authConfig = connection.authConfig;

      if (isMcpConnectionOAuthConfig(authConfig)) {
        // OAuth flow — resolve access token, refreshing if needed
        const upstreamUrl = getMcpIntegrationUpstreamUrl(integration);

        if (!upstreamUrl) {
          console.warn(
            `[getMcpServerConfigs] Missing upstream URL for OAuth-backed MCP ${integration.id}, skipping`,
          );
          continue;
        }

        const accessToken = await getValidAccessToken(
          connection.id,
          upstreamUrl,
        );

        if (!accessToken) {
          console.warn(
            `[getMcpServerConfigs] No tokens found for connection ${connection.id}, skipping`,
          );
          logInfo('[getMcpServerConfigs] Skipping connection:', {
            connectionId: connection.id,
            mcpId: connection.mcpId,
            reason: 'missing_access_token',
          });
          continue;
        }

        if (INTEGRATION_PROXY_MCP_IDS.has(connection.mcpId)) {
          servers[connection.mcpId] = {
            url: buildProxyUrl(connection.mcpId, requestOrigin),
            headers,
          };
          logInfo('[getMcpServerConfigs] Included connection:', {
            connectionId: connection.id,
            mcpId: connection.mcpId,
            via: 'proxy',
          });
          continue;
        }

        headers['Authorization'] = `Bearer ${accessToken}`;
      } else if (
        isMcpConnectionSnowflakeConfig(authConfig) ||
        isMcpConnectionAsanaConfig(authConfig) ||
        isMcpConnectionNotionConfig(authConfig) ||
        isMcpConnectionGranolaConfig(authConfig) ||
        isMcpConnectionVercelConfig(authConfig) ||
        isMcpConnectionGrafanaConfig(authConfig) ||
        isMcpConnectionGbrainConfig(authConfig) ||
        isMcpConnectionXConfig(authConfig)
      ) {
        servers[connection.mcpId] = {
          url: buildProxyUrl(connection.mcpId, requestOrigin),
          headers,
        };
        logInfo('[getMcpServerConfigs] Included connection:', {
          connectionId: connection.id,
          mcpId: connection.mcpId,
          via: 'native_proxy',
        });
        continue;
      } else {
        // No valid auth config — skip pending/incomplete connections
        logInfo('[getMcpServerConfigs] Skipping connection:', {
          connectionId: connection.id,
          mcpId: connection.mcpId,
          reason: 'invalid_auth_config',
        });
        continue;
      }

      const upstreamUrl = getMcpIntegrationUpstreamUrl(integration);

      if (!upstreamUrl) {
        logInfo('[getMcpServerConfigs] Skipping connection:', {
          connectionId: connection.id,
          mcpId: connection.mcpId,
          reason: 'missing_upstream_url',
        });
        continue;
      }

      servers[connection.mcpId] = { url: upstreamUrl, headers };
      logInfo('[getMcpServerConfigs] Included connection:', {
        connectionId: connection.id,
        mcpId: connection.mcpId,
        via: 'upstream',
      });
    } catch (error) {
      console.error(
        `[getMcpServerConfigs] Failed to build config for ${connection.id}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  for (const server of enabledConnections) {
    if (server.disabledTools?.length && servers[server.enabledMcpId]) {
      servers[server.enabledMcpId]!.disabledTools = server.disabledTools;
    }
  }

  return servers;
}
