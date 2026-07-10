import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  db,
  desc,
  mcpConnections,
  deploymentMcpEnablements,
  eq,
  and,
  inArray,
  isNull,
  or,
} from '@roomote/db/server';
import { getValidAccessToken, hasValidOAuthTokens } from '../lib/mcp/data';
import {
  getMcpIntegrationUpstreamUrl,
  MCP_INTEGRATIONS,
  isMcpConnectionAsanaConfig,
  isMcpConnectionGrafanaConfig,
  getMcpIntegration,
  getMcpIntegrationConnectionScope,
  isMcpConnectionOAuthConfig,
  isMcpConnectionSnowflakeConfig,
  isMcpConnectionVercelConfig,
  isDeploymentScopedMcpIntegration,
  PRODUCT_NAME,
} from '@roomote/types';

import { authenticatedProcedure, userOnlyProcedure, router } from '../trpc';
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

function buildProxyUrl(mcpId: string, requestOrigin: string | null): string {
  const proxyPath = `/api/mcp/${mcpId}`;
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

export const mcpConnectionsRouter = router({
  isOrgEnabled: authenticatedProcedure
    .input(
      z.object({
        mcpId: z.string(),
      }),
    )
    .query(async ({ input }) => {
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
  getMcpServerConfigs: authenticatedProcedure.query(async ({ ctx }) => {
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
      return { servers: {} };
    }

    const enabledConnections = await db
      .select({
        enabledMcpId: deploymentMcpEnablements.mcpId,
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
    const deploymentScopedEnabledIds = Array.from(enabledMcpIds).filter(
      (mcpId) => isDeploymentScopedMcpIntegration(mcpId),
    );
    const userScopedEnabledIds = Array.from(enabledMcpIds).filter(
      (mcpId) => !isDeploymentScopedMcpIntegration(mcpId),
    );
    const connections = enabledConnections.flatMap(({ connection }) =>
      connection ? [connection] : [],
    );

    console.info('[getMcpServerConfigs] Enabled MCP IDs found:', [
      ...enabledMcpIds,
    ]);
    console.info('[getMcpServerConfigs] Connection filter counts:', {
      deploymentScopedCount: deploymentScopedEnabledIds.length,
      userScopedCount: actorContext.userId ? userScopedEnabledIds.length : 0,
    });

    const servers: Record<
      string,
      { url: string; headers: Record<string, string> }
    > = {};
    const requestOrigin = getRequestOrigin(ctx.req);

    for (const connection of connections) {
      console.info('[getMcpServerConfigs] Processing connection:', {
        connectionId: connection.id,
        mcpId: connection.mcpId,
        userId: connection.userId,
      });

      if (!enabledMcpIds.has(connection.mcpId)) {
        console.info('[getMcpServerConfigs] Skipping connection:', {
          connectionId: connection.id,
          mcpId: connection.mcpId,
          reason: 'mcp_not_enabled',
        });
        continue;
      }

      const integration = getMcpIntegration(connection.mcpId);
      if (!integration) {
        console.info('[getMcpServerConfigs] Skipping connection:', {
          connectionId: connection.id,
          mcpId: connection.mcpId,
          reason: 'integration_not_found',
        });
        continue;
      }

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
        console.info('[getMcpServerConfigs] Included connection:', {
          connectionId: connection.id,
          mcpId: connection.mcpId,
          via: 'linear_proxy',
        });
        continue;
      }

      const connectionScope = getMcpIntegrationConnectionScope(integration);
      if (
        (connectionScope === 'deployment' && connection.userId !== null) ||
        (connectionScope === 'user' &&
          (!actorContext.userId || connection.userId !== actorContext.userId))
      ) {
        console.info('[getMcpServerConfigs] Skipping connection:', {
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
            console.info('[getMcpServerConfigs] Skipping connection:', {
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
            console.info('[getMcpServerConfigs] Included connection:', {
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
          isMcpConnectionVercelConfig(authConfig) ||
          isMcpConnectionGrafanaConfig(authConfig)
        ) {
          servers[connection.mcpId] = {
            url: buildProxyUrl(connection.mcpId, requestOrigin),
            headers,
          };
          console.info('[getMcpServerConfigs] Included connection:', {
            connectionId: connection.id,
            mcpId: connection.mcpId,
            via: 'native_proxy',
          });
          continue;
        } else {
          // No valid auth config — skip pending/incomplete connections
          console.info('[getMcpServerConfigs] Skipping connection:', {
            connectionId: connection.id,
            mcpId: connection.mcpId,
            reason: 'invalid_auth_config',
          });
          continue;
        }

        const upstreamUrl = getMcpIntegrationUpstreamUrl(integration);

        if (!upstreamUrl) {
          console.info('[getMcpServerConfigs] Skipping connection:', {
            connectionId: connection.id,
            mcpId: connection.mcpId,
            reason: 'missing_upstream_url',
          });
          continue;
        }

        servers[connection.mcpId] = { url: upstreamUrl, headers };
        console.info('[getMcpServerConfigs] Included connection:', {
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

    console.info('[getMcpServerConfigs] Final resolved server keys:', [
      ...Object.keys(servers),
    ]);

    return { servers };
  }),
});
