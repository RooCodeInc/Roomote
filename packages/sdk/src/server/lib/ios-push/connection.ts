import { and, db, eq, isNull, mcpConnections } from '@roomote/db/server';
import { decrypt } from '@roomote/db/encryption';
import { isMcpConnectionIosAppConfig } from '@roomote/types';

import type { ApnsCredentials } from './apns';

export const IOS_APP_MCP_ID = 'ios_app';

export type IosAppConnection = {
  teamId: string;
  keyId: string;
  bundleId: string;
  enabled: boolean;
};

/**
 * The deployment's iOS app settings without the private key, for surfaces
 * that only need to know whether (and for which app id) push is set up.
 */
export async function getIosAppConnection(): Promise<IosAppConnection | null> {
  const connection = await db.query.mcpConnections.findFirst({
    where: and(
      eq(mcpConnections.mcpId, IOS_APP_MCP_ID),
      isNull(mcpConnections.userId),
      eq(mcpConnections.connectionRole, 'default'),
    ),
    columns: { authConfig: true, enabled: true },
  });
  if (!connection || !isMcpConnectionIosAppConfig(connection.authConfig)) {
    return null;
  }
  return {
    teamId: connection.authConfig.teamId,
    keyId: connection.authConfig.keyId,
    bundleId: connection.authConfig.bundleId,
    enabled: connection.enabled,
  };
}

/**
 * The full APNs credentials, private key decrypted. Only the push sender
 * should call this; nothing else needs the key.
 */
export async function resolveApnsCredentials(): Promise<ApnsCredentials | null> {
  const connection = await db.query.mcpConnections.findFirst({
    where: and(
      eq(mcpConnections.mcpId, IOS_APP_MCP_ID),
      isNull(mcpConnections.userId),
      eq(mcpConnections.connectionRole, 'default'),
    ),
    columns: { authConfig: true, enabled: true },
  });
  if (
    !connection?.enabled ||
    !isMcpConnectionIosAppConfig(connection.authConfig)
  ) {
    return null;
  }
  return {
    teamId: connection.authConfig.teamId,
    keyId: connection.authConfig.keyId,
    bundleId: connection.authConfig.bundleId,
    privateKey: decrypt(connection.authConfig.encryptedPrivateKey),
  };
}
