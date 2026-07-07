import { createAuthToken } from '@roomote/auth';
import {
  and,
  db,
  eq,
  githubInstallations,
  mcpConnections,
  deploymentMcpEnablements,
  isNull,
} from '@roomote/db/server';

import type { RoutingContext } from './types';
import { isRouterMcpServerEnabled, type RouterMcpServerId } from './mcp-policy';
import { resolveApiBaseUrl } from '../shared-utils';

interface RouterMcpServer {
  id: RouterMcpServerId;
  url: string;
  headers: Record<string, string>;
}

export async function resolveConfiguredRouterMcpServers(
  context: RoutingContext,
  options?: {
    includeRoomote?: boolean;
  },
): Promise<RouterMcpServer[]> {
  const actor = context.routingActor;
  if (!actor) return [];

  const apiBaseUrl = resolveApiBaseUrl(context.routingActor?.apiBaseUrl);
  if (!apiBaseUrl) return [];

  const authToken = await createAuthToken({
    userId: actor.userId,
    timeoutMs: 2 * 60_000,
  });

  const [linearMcpConnection, githubInstallation] = await Promise.all([
    db.query.mcpConnections.findFirst({
      where: and(
        eq(mcpConnections.mcpId, 'linear'),
        eq(mcpConnections.enabled, true),
        eq(mcpConnections.authStatus, 'authenticated'),
        isNull(mcpConnections.userId),
      ),
      columns: { id: true },
    }),
    db.query.githubInstallations.findFirst({
      where: isNull(githubInstallations.suspendedAt),
      columns: { id: true },
    }),
  ]);

  const linearEnablement = linearMcpConnection
    ? await db.query.deploymentMcpEnablements.findFirst({
        where: and(
          eq(deploymentMcpEnablements.mcpId, 'linear'),
          eq(deploymentMcpEnablements.enabled, true),
        ),
        columns: { mcpId: true },
      })
    : null;

  const authorization = `Bearer ${authToken}`;
  const servers: RouterMcpServer[] = [];

  if (
    options?.includeRoomote !== false &&
    isRouterMcpServerEnabled('roomote')
  ) {
    servers.push({
      id: 'roomote',
      url: `${apiBaseUrl}/api/mcp-routing/roomote`,
      headers: { Authorization: authorization },
    });
  }

  if (linearEnablement && isRouterMcpServerEnabled('linear')) {
    servers.push({
      id: 'linear',
      url: `${apiBaseUrl}/api/mcp-routing/linear`,
      headers: { Authorization: authorization },
    });
  }

  if (githubInstallation && isRouterMcpServerEnabled('github')) {
    servers.push({
      id: 'github',
      url: `${apiBaseUrl}/api/mcp-routing/github`,
      headers: { Authorization: authorization },
    });
  }

  return servers;
}
