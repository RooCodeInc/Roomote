import { db } from '@roomote/db/server';
import {
  findLinearDeploymentMcpConnection,
  getLinearDeploymentMetadata,
} from '@roomote/sdk/server';

import type { UserAuthSuccess } from '@/types';

import { clearLinearDeploymentConnection } from './oauth-setup';

export {
  getLinearOauthSetupCommand,
  removeLinearOauthSetupCommand,
  saveLinearOauthSetupCommand,
} from './oauth-setup';

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
