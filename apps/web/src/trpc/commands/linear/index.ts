import { db } from '@roomote/db/server';
import { LINEAR_APP_OAUTH_SCOPES } from '@roomote/types';
import {
  findLinearDeploymentMcpConnection,
  getLinearDeploymentMetadata,
} from '@roomote/sdk/server';

import type { UserAuthSuccess } from '@/types';

import { clearLinearDeploymentConnection } from './oauth-setup';

export {
  getLinearOauthSetupCommand,
  saveLinearOauthSetupCommand,
} from './oauth-setup';

type LinearInstallationSummary = {
  id: string;
  authStatus: 'pending' | 'authenticated' | 'error' | null;
  linearOrganizationId: string;
  linearOrganizationName: string | null;
  linearOrganizationUrlKey: string | null;
  appUserId: string | null;
  requiresReconnect: boolean;
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
    requiresReconnect: !LINEAR_APP_OAUTH_SCOPES.every((scope) =>
      connection.scopes?.includes(scope),
    ),
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

    await clearLinearDeploymentConnection(db, auth.userId);

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
