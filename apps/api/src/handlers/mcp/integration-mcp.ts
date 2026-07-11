import {
  and,
  db,
  eq,
  isNull,
  mcpConnections,
  deploymentMcpEnablements,
} from '@roomote/db/server';
import { getValidAccessToken } from '@roomote/sdk/server';
import {
  getMcpIntegrationUpstreamUrl,
  getMcpIntegrationConnectionScope,
  type McpIntegration,
} from '@roomote/types';

import {
  createMcpProxy,
  McpProxyError,
  resolveActingUserId,
  resolveActingUserIdOrNull,
} from './proxy-utils';

async function resolveOAuthAccessToken(
  mcpId: string,
  mcpUrl: string,
  userId: string | null,
): Promise<{
  accessToken: string | null;
}> {
  const connectionScope = getMcpIntegrationConnectionScope(mcpId);
  const connectionOwnerFilter =
    connectionScope === 'deployment'
      ? isNull(mcpConnections.userId)
      : userId
        ? eq(mcpConnections.userId, userId)
        : null;

  // A user-scoped integration cannot resolve a connection without a human
  // actor to look up.
  if (!connectionOwnerFilter) {
    return {
      accessToken: null,
    };
  }

  const connection = await db.query.mcpConnections.findFirst({
    where: and(
      eq(mcpConnections.mcpId, mcpId),
      eq(mcpConnections.enabled, true),
      connectionOwnerFilter,
    ),
  });

  if (!connection) {
    return {
      accessToken: null,
    };
  }

  return {
    accessToken: (await getValidAccessToken(connection.id, mcpUrl)) ?? null,
  };
}

async function resolveDeploymentDisabledToolNames(
  mcpId: string,
): Promise<string[] | null> {
  const enablement = await db.query.deploymentMcpEnablements.findFirst({
    where: and(
      eq(deploymentMcpEnablements.mcpId, mcpId),
      eq(deploymentMcpEnablements.enabled, true),
    ),
    columns: {
      disabledTools: true,
    },
  });

  return enablement?.disabledTools ?? null;
}

export function createIntegrationMcpProxy(
  integration: McpIntegration,
  options?: {
    allowAuthTokens?: boolean;
    allowedToolNames?: readonly string[];
  },
) {
  const upstreamUrl = getMcpIntegrationUpstreamUrl(integration);

  if (!upstreamUrl) {
    throw new Error(
      `${integration.name} does not define an upstream MCP URL for proxying`,
    );
  }

  return createMcpProxy({
    name: integration.name,
    upstream: upstreamUrl,
    allowAuthTokens: options?.allowAuthTokens,
    allowedToolNames: options?.allowedToolNames,
    // Integration OAuth MCPs resolve acting-user credentials directly.
    validateTaskRunToken: async () => null,
    resolveCredentials: async (auth) => {
      // Deployment-scoped integrations use an org-wide connection, so runs
      // without a human actor (deployment service principal jobs) can still
      // use them. User-scoped integrations require the acting human whose
      // credentials the call runs as.
      const actingUserId =
        getMcpIntegrationConnectionScope(integration) === 'deployment'
          ? await resolveActingUserIdOrNull(auth)
          : await resolveActingUserId(auth);

      let accessToken: string | null;
      let disabledToolNames: string[] | null = null;
      try {
        const resolvedConnection = await resolveOAuthAccessToken(
          integration.id,
          upstreamUrl,
          actingUserId,
        );
        accessToken = resolvedConnection.accessToken;
        disabledToolNames = await resolveDeploymentDisabledToolNames(
          integration.id,
        );
      } catch (error) {
        if (error instanceof McpProxyError) {
          throw error;
        }

        throw new McpProxyError(
          500,
          `Failed to resolve ${integration.name} OAuth token: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      if (!accessToken) {
        throw new McpProxyError(
          404,
          getMcpIntegrationConnectionScope(integration) === 'deployment'
            ? `No active ${integration.name} connection with valid OAuth tokens found for this workspace`
            : `No active ${integration.name} connection with valid OAuth tokens found for this user`,
        );
      }

      return {
        authHeader: accessToken,
        disabledToolNames,
      };
    },
  });
}
