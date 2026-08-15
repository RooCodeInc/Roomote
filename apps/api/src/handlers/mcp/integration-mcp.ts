import {
  and,
  db,
  eq,
  isNull,
  mcpConnections,
  deploymentMcpEnablements,
} from '@roomote/db/server';
import { decrypt } from '@roomote/db/encryption';
import { getValidAccessToken } from '@roomote/sdk/server';
import {
  getMcpIntegrationUpstreamUrl,
  getMcpIntegrationConnectionScope,
  getAllowedIntegrationMcpToolNames,
  isMcpConnectionXConfig,
  type McpIntegration,
} from '@roomote/types';

import {
  createMcpProxy,
  McpProxyError,
  resolveActingUserId,
  resolveActingUserIdOrNull,
} from './proxy-utils';

async function resolveUpstreamAccessToken(
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

  // Admin-configured upstream integrations store a static bearer token
  // instead of OAuth tokens; the proxy forwards it as-is.
  if (isMcpConnectionXConfig(connection.authConfig)) {
    const bearerToken = decrypt(
      connection.authConfig.encryptedBearerToken,
    ).trim();

    return {
      accessToken: bearerToken.length > 0 ? bearerToken : null,
    };
  }

  return {
    accessToken: (await getValidAccessToken(connection.id, mcpUrl)) ?? null,
  };
}

async function resolveDeploymentToolPolicy(mcpId: string) {
  const enablement = await db.query.deploymentMcpEnablements.findFirst({
    where: and(
      eq(deploymentMcpEnablements.mcpId, mcpId),
      eq(deploymentMcpEnablements.enabled, true),
    ),
    columns: {
      disabledTools: true,
    },
  });

  return {
    disabledToolNames: enablement?.disabledTools ?? null,
    allowedToolNames: getAllowedIntegrationMcpToolNames(mcpId) ?? null,
  };
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
    // Resend's z.email() tool schemas include regex lookarounds that Azure
    // OpenAI rejects. The upstream Resend server still validates tool calls.
    stripToolSchemaPatterns: integration.id === 'resend',
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
      let toolPolicy: Awaited<ReturnType<typeof resolveDeploymentToolPolicy>>;
      try {
        const resolvedConnection = await resolveUpstreamAccessToken(
          integration.id,
          upstreamUrl,
          actingUserId,
        );
        accessToken = resolvedConnection.accessToken;
        toolPolicy = await resolveDeploymentToolPolicy(integration.id);
      } catch (error) {
        if (error instanceof McpProxyError) {
          throw error;
        }

        throw new McpProxyError(
          500,
          `Failed to resolve ${integration.name} credentials: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      if (!accessToken) {
        throw new McpProxyError(
          404,
          getMcpIntegrationConnectionScope(integration) === 'deployment'
            ? `No active ${integration.name} connection with valid credentials found for this workspace`
            : `No active ${integration.name} connection with valid credentials found for this user`,
        );
      }

      return {
        authHeader: accessToken,
        ...toolPolicy,
      };
    },
  });
}
