import { and, db, eq, deploymentMcpEnablements } from '@roomote/db/server';
import {
  findLinearDeploymentMcpConnection,
  getValidAccessToken,
} from '@roomote/sdk/server';

import { createMcpProxy, McpProxyError } from './proxy-utils';

const LINEAR_MCP_URL = 'https://mcp.linear.app/mcp';

async function resolveLinearAccessToken(): Promise<string | null> {
  const connection = await findLinearDeploymentMcpConnection();
  if (!connection) {
    return null;
  }

  const accessToken = await getValidAccessToken(connection.id, LINEAR_MCP_URL);
  return accessToken ?? null;
}

async function resolveLinearDisabledToolNames(): Promise<string[] | null> {
  const enablement = await db.query.deploymentMcpEnablements.findFirst({
    where: and(
      eq(deploymentMcpEnablements.mcpId, 'linear'),
      eq(deploymentMcpEnablements.enabled, true),
    ),
    columns: {
      disabledTools: true,
    },
  });

  return enablement?.disabledTools ?? null;
}

export function createLinearMcp(options?: {
  allowAuthTokens?: boolean;
  allowAutomationTokens?: boolean;
  allowedToolNames?: readonly string[];
}) {
  return createMcpProxy({
    name: 'Linear',
    upstream: LINEAR_MCP_URL,
    allowAuthTokens: options?.allowAuthTokens,
    allowAutomationTokens: options?.allowAutomationTokens,
    allowedToolNames: options?.allowedToolNames,
    resolveCredentials: async () => {
      const [linearAccessToken, disabledToolNames] = await Promise.all([
        resolveLinearAccessToken(),
        resolveLinearDisabledToolNames(),
      ]);

      if (!linearAccessToken) {
        throw new McpProxyError(
          404,
          'No active Linear MCP connection found for this deployment',
        );
      }

      return { authHeader: linearAccessToken, disabledToolNames };
    },
  });
}
