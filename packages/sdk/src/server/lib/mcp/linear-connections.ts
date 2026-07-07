import { and, db, eq, isNull, mcpConnections } from '@roomote/db/server';
import type { McpConnectionAuthConfig } from '@roomote/types';

export const LINEAR_ORG_CONNECTION_ROLE = 'linear_org_install';
export const LINEAR_USER_CONNECTION_ROLE = 'linear_user_link';

type LinearDeploymentMcpMetadata = {
  linearOrganizationId: string;
  linearOrganizationName: string | null;
  linearOrganizationUrlKey: string | null;
  appUserId: string | null;
};

type LinearUserMcpMetadata = {
  linearOrganizationId: string;
  linearUserId: string;
};

function getLinearMetadataRecord(
  authConfig: McpConnectionAuthConfig | null | undefined,
): Record<string, unknown> | null {
  return authConfig && typeof authConfig === 'object'
    ? (authConfig as Record<string, unknown>)
    : null;
}

export function getLinearDeploymentMetadata(
  authConfig: McpConnectionAuthConfig | null | undefined,
): LinearDeploymentMcpMetadata | null {
  const config = getLinearMetadataRecord(authConfig);
  if (!config || typeof config.linearOrganizationId !== 'string') {
    return null;
  }

  return {
    linearOrganizationId: config.linearOrganizationId,
    linearOrganizationName:
      typeof config.linearOrganizationName === 'string'
        ? config.linearOrganizationName
        : null,
    linearOrganizationUrlKey:
      typeof config.linearOrganizationUrlKey === 'string'
        ? config.linearOrganizationUrlKey
        : null,
    appUserId: typeof config.appUserId === 'string' ? config.appUserId : null,
  };
}

export function getLinearUserMetadata(
  authConfig: McpConnectionAuthConfig | null | undefined,
): LinearUserMcpMetadata | null {
  const config = getLinearMetadataRecord(authConfig);
  if (
    !config ||
    typeof config.linearOrganizationId !== 'string' ||
    typeof config.linearUserId !== 'string'
  ) {
    return null;
  }

  return {
    linearOrganizationId: config.linearOrganizationId,
    linearUserId: config.linearUserId,
  };
}

export async function findLinearDeploymentMcpConnection() {
  return db.query.mcpConnections.findFirst({
    where: and(
      eq(mcpConnections.mcpId, 'linear'),
      eq(mcpConnections.connectionRole, LINEAR_ORG_CONNECTION_ROLE),
      isNull(mcpConnections.userId),
    ),
  });
}

export async function findLinearDeploymentMcpConnectionByIdentity(input: {
  linearOrganizationId: string;
}) {
  const connections = await db.query.mcpConnections.findMany({
    where: and(
      eq(mcpConnections.mcpId, 'linear'),
      eq(mcpConnections.connectionRole, LINEAR_ORG_CONNECTION_ROLE),
      isNull(mcpConnections.userId),
    ),
  });

  return (
    connections.find((connection) => {
      const metadata = getLinearDeploymentMetadata(connection.authConfig);
      return metadata?.linearOrganizationId === input.linearOrganizationId;
    }) ?? null
  );
}

export async function findLinearUserMcpConnection(input: { userId: string }) {
  return db.query.mcpConnections.findFirst({
    where: and(
      eq(mcpConnections.mcpId, 'linear'),
      eq(mcpConnections.connectionRole, LINEAR_USER_CONNECTION_ROLE),
      eq(mcpConnections.userId, input.userId),
    ),
  });
}

export async function findLinearUserMcpConnectionByIdentity(input: {
  linearOrganizationId: string;
  linearUserId: string;
}) {
  const connections = await db.query.mcpConnections.findMany({
    where: and(
      eq(mcpConnections.mcpId, 'linear'),
      eq(mcpConnections.connectionRole, LINEAR_USER_CONNECTION_ROLE),
    ),
    columns: {
      id: true,
      userId: true,
      authConfig: true,
    },
  });

  return (
    connections.find((connection) => {
      const metadata = getLinearUserMetadata(connection.authConfig);
      return (
        metadata?.linearOrganizationId === input.linearOrganizationId &&
        metadata.linearUserId === input.linearUserId
      );
    }) ?? null
  );
}
