import {
  and,
  db,
  deploymentMcpEnablements,
  eq,
  isNull,
  mcpConnections,
  type DatabaseOrTransaction,
} from '@roomote/db/server';
import type { McpConnectionAuthConfig } from '@roomote/types';

import { captureIntegrationConnectionTransitions } from '@/lib/server/integration-telemetry';

type SaveAuthenticatedDeploymentMcpConnectionInput<
  TAuthConfig extends McpConnectionAuthConfig,
> = {
  mcpId: string;
  userId: string;
  buildAuthConfig: (
    existingAuthConfig: McpConnectionAuthConfig | null,
  ) => TAuthConfig | Promise<TAuthConfig>;
  clearOauthTokens?: boolean;
  resetDisabledTools?: boolean;
};

async function persistDeploymentMcpIntegrationEnabled(
  database: DatabaseOrTransaction,
  input: {
    mcpId: string;
    userId: string;
    defaultDisabledTools?: string[];
    resetDisabledTools?: boolean;
  },
): Promise<boolean> {
  const updatedDisabledTools = input.resetDisabledTools ? null : undefined;
  const insertedDisabledTools = input.resetDisabledTools
    ? null
    : input.defaultDisabledTools?.length
      ? input.defaultDisabledTools
      : undefined;
  const [reenabled] = await database
    .update(deploymentMcpEnablements)
    .set({
      enabled: true,
      enabledByUserId: input.userId,
      ...(updatedDisabledTools !== undefined
        ? { disabledTools: updatedDisabledTools }
        : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(deploymentMcpEnablements.mcpId, input.mcpId),
        eq(deploymentMcpEnablements.enabled, false),
      ),
    )
    .returning({ mcpId: deploymentMcpEnablements.mcpId });

  if (reenabled) {
    return true;
  }

  const [inserted] = await database
    .insert(deploymentMcpEnablements)
    .values({
      mcpId: input.mcpId,
      enabled: true,
      enabledByUserId: input.userId,
      ...(insertedDisabledTools !== undefined
        ? { disabledTools: insertedDisabledTools }
        : {}),
    })
    .onConflictDoNothing({ target: deploymentMcpEnablements.mcpId })
    .returning({ mcpId: deploymentMcpEnablements.mcpId });

  if (inserted) {
    return true;
  }

  const [enabledAfterConflict] = await database
    .update(deploymentMcpEnablements)
    .set({
      enabled: true,
      enabledByUserId: input.userId,
      ...(updatedDisabledTools !== undefined
        ? { disabledTools: updatedDisabledTools }
        : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(deploymentMcpEnablements.mcpId, input.mcpId),
        eq(deploymentMcpEnablements.enabled, false),
      ),
    )
    .returning({ mcpId: deploymentMcpEnablements.mcpId });

  if (enabledAfterConflict) {
    return true;
  }

  await database
    .update(deploymentMcpEnablements)
    .set({
      enabledByUserId: input.userId,
      ...(updatedDisabledTools !== undefined
        ? { disabledTools: updatedDisabledTools }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(deploymentMcpEnablements.mcpId, input.mcpId));

  return false;
}

export async function saveAuthenticatedDeploymentMcpConnection<
  TAuthConfig extends McpConnectionAuthConfig,
>(
  input: SaveAuthenticatedDeploymentMcpConnectionInput<TAuthConfig>,
): Promise<TAuthConfig> {
  const existingConnection = await db.query.mcpConnections.findFirst({
    where: and(
      eq(mcpConnections.mcpId, input.mcpId),
      isNull(mcpConnections.userId),
    ),
    columns: { authConfig: true },
  });
  const authConfig = await input.buildAuthConfig(
    existingConnection?.authConfig ?? null,
  );

  const transitions = await db.transaction(async (tx) => {
    const [insertedConnection] = await tx
      .insert(mcpConnections)
      .values({
        userId: null,
        mcpId: input.mcpId,
        connectionRole: 'default',
        authConfig,
        enabled: true,
        authStatus: 'authenticated',
      })
      .onConflictDoNothing({
        target: [
          mcpConnections.userId,
          mcpConnections.mcpId,
          mcpConnections.connectionRole,
        ],
      })
      .returning({ id: mcpConnections.id });

    if (!insertedConnection) {
      await tx
        .update(mcpConnections)
        .set({
          authConfig,
          ...(input.clearOauthTokens
            ? {
                accessToken: null,
                refreshToken: null,
                tokenExpiresAt: null,
                scopes: null,
              }
            : {}),
          enabled: true,
          authStatus: 'authenticated',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(mcpConnections.mcpId, input.mcpId),
            isNull(mcpConnections.userId),
            eq(mcpConnections.connectionRole, 'default'),
          ),
        );
    }

    const enabled = await persistDeploymentMcpIntegrationEnabled(tx, {
      mcpId: input.mcpId,
      userId: input.userId,
      resetDisabledTools: input.resetDisabledTools,
    });

    return { connected: Boolean(insertedConnection), enabled };
  });

  captureIntegrationConnectionTransitions({
    integrationId: input.mcpId,
    userId: input.userId,
    ...transitions,
  });

  return authConfig;
}

export async function enableDeploymentMcpIntegration(input: {
  mcpId: string;
  userId: string;
  defaultDisabledTools: string[];
}): Promise<boolean> {
  return persistDeploymentMcpIntegrationEnabled(db, input);
}
