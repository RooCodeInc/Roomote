import {
  and,
  db,
  eq,
  isNull,
  mcpConnections,
  deploymentMcpEnablements,
} from '@roomote/db/server';
import {
  findLinearDeploymentMcpConnection,
  getLinearDeploymentMetadata,
  LINEAR_ORG_CONNECTION_ROLE,
} from '@roomote/sdk/server';

import type { UserAuthSuccess } from '@/types';

type LinearInstallationSummary = {
  id: string;
  authStatus: 'pending' | 'authenticated' | 'error' | null;
  linearOrganizationId: string;
  linearOrganizationName: string | null;
  linearOrganizationUrlKey: string | null;
  appUserId: string | null;
};

export async function getLinearInstallationCommand(
  auth: UserAuthSuccess,
): Promise<LinearInstallationSummary | null> {
  void auth;

  const connection = await findLinearDeploymentMcpConnection();
  const metadata = getLinearDeploymentMetadata(connection?.authConfig);
  if (!connection || !metadata) {
    return null;
  }

  return {
    id: connection.id,
    authStatus: connection.authStatus,
    linearOrganizationId: metadata.linearOrganizationId,
    linearOrganizationName: metadata.linearOrganizationName,
    linearOrganizationUrlKey: metadata.linearOrganizationUrlKey,
    appUserId: metadata.appUserId,
  };
}

export async function disconnectLinearAppCommand(
  auth: UserAuthSuccess,
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    if (!auth.isAdmin) {
      return {
        success: false,
        error: 'Unauthorized',
      };
    }

    await db
      .delete(mcpConnections)
      .where(
        and(
          eq(mcpConnections.mcpId, 'linear'),
          eq(mcpConnections.connectionRole, LINEAR_ORG_CONNECTION_ROLE),
          isNull(mcpConnections.userId),
        ),
      );

    await db
      .insert(deploymentMcpEnablements)
      .values({
        mcpId: 'linear',
        enabled: false,
        enabledByUserId: auth.userId,
      })
      .onConflictDoUpdate({
        target: deploymentMcpEnablements.mcpId,
        set: {
          enabled: false,
          enabledByUserId: auth.userId,
          updatedAt: new Date(),
        },
      });

    return { success: true };
  } catch (error) {
    console.error('Failed to disconnect Linear app:', error);
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Failed to disconnect Linear app',
    };
  }
}
