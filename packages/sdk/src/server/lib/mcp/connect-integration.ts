import { randomUUID } from 'node:crypto';

import {
  and,
  db,
  deploymentMcpEnablements,
  eq,
  isNull,
  mcpConnections,
  mcpOauthReplays,
  or,
  resolveDeploymentEnvVar,
  sessions,
  users,
} from '@roomote/db/server';
import { Env, areCuratedIntegrationsDisabled } from '@roomote/env';
import {
  getDefaultMcpConnectionRole,
  getMcpIntegrationConnectionMode,
  getMcpIntegrationConnectionScope,
  isMcpConnectionOAuthConfig,
  getMcpIntegration,
  MCP_INTEGRATIONS,
  type NativeIntegrationCatalogEntry,
} from '@roomote/types';

import { createMcpOauthReplay, hasValidOAuthTokens } from './data';

const OAUTH_REPLAY_TTL_MS = 24 * 60 * 60 * 1000;

export type NativeIntegrationSetupStrategy = 'oauth' | 'settings' | 'keyless';

export function getNativeIntegrationSetupStrategy(
  integration: (typeof MCP_INTEGRATIONS)[number],
): NativeIntegrationSetupStrategy {
  if (integration.supportsKeylessAccess) return 'keyless';
  if (
    integration.url &&
    (getMcpIntegrationConnectionMode(integration) === 'oauth' ||
      Boolean(integration.oauthEndpoints))
  ) {
    return 'oauth';
  }
  return 'settings';
}

export type ConnectIntegrationResult =
  | { status: 'unavailable'; id: string; name: string }
  | { status: 'permission_denied'; id: string; name: string }
  | { status: 'connected'; id: string; name: string }
  | {
      status: 'authorization_required';
      id: string;
      name: string;
      authorizeUrl: string;
    }
  | {
      status: 'operator_configuration_required';
      id: string;
      name: string;
      settingsUrl: string;
      requiredEnvironmentVariables: string[];
    }
  | {
      status: 'configuration_required';
      id: string;
      name: string;
      settingsUrl: string;
    };

function publicUrl(path: string): string {
  return new URL(path, Env.R_PUBLIC_URL ?? Env.R_APP_URL).toString();
}

async function hasConfiguredOauthClient(
  integration: (typeof MCP_INTEGRATIONS)[number],
): Promise<boolean> {
  const client = integration.oauthClientEnv;
  if (!client) return true;

  const values = await Promise.all(
    [client.clientIdEnv, client.clientSecretEnv]
      .filter((key): key is string => Boolean(key))
      .map((key) =>
        resolveDeploymentEnvVar(key, db, {
          [key]: (Env as unknown as Record<string, string | undefined>)[key],
        }),
      ),
  );
  return values.every((value) => Boolean(value?.trim()));
}

async function prepareReplay(input: {
  userId: string;
  sessionId: string;
  mcpId: string;
  connectionRole: ReturnType<typeof getDefaultMcpConnectionRole>;
}) {
  const existing = await db.query.mcpOauthReplays.findFirst({
    where: and(
      eq(mcpOauthReplays.userId, input.userId),
      eq(mcpOauthReplays.mcpId, input.mcpId),
      eq(mcpOauthReplays.connectionRole, input.connectionRole),
      eq(mcpOauthReplays.sessionId, input.sessionId),
    ),
    orderBy: (table, { desc }) => [desc(table.createdAt)],
  });
  if (existing && existing.expiresAt > new Date()) {
    return publicUrl(
      `/api/mcp-oauth/replay/${encodeURIComponent(existing.token)}`,
    );
  }

  const token = randomUUID();
  await createMcpOauthReplay({
    token,
    userId: input.userId,
    mcpId: input.mcpId,
    connectionRole: input.connectionRole,
    sessionId: input.sessionId,
    redirectTo: `/sessions/${encodeURIComponent(input.sessionId)}`,
    expiresAt: new Date(Date.now() + OAUTH_REPLAY_TTL_MS),
  });
  return publicUrl(`/api/mcp-oauth/replay/${encodeURIComponent(token)}`);
}

export async function listNativeIntegrationsForFast(input: {
  userId: string;
}): Promise<NativeIntegrationCatalogEntry[]> {
  const [user, enablements, connections] = await Promise.all([
    db.query.users.findFirst({
      where: eq(users.id, input.userId),
      columns: { role: true, deletedAt: true },
    }),
    db.query.deploymentMcpEnablements.findMany({
      columns: { mcpId: true, enabled: true },
    }),
    db.query.mcpConnections.findMany({
      where: or(
        isNull(mcpConnections.userId),
        eq(mcpConnections.userId, input.userId),
      ),
      orderBy: (table, { desc }) => [desc(table.createdAt)],
      columns: {
        userId: true,
        mcpId: true,
        connectionRole: true,
        enabled: true,
        authStatus: true,
      },
    }),
  ]);
  const available = !areCuratedIntegrationsDisabled(
    Env.R_CURATED_INTEGRATIONS_DISABLED,
  );
  const enabledById = new Map(
    enablements.map((entry) => [entry.mcpId, entry.enabled]),
  );

  return MCP_INTEGRATIONS.map((integration) => {
    const connectionRole = getDefaultMcpConnectionRole(integration);
    const connectionScope = getMcpIntegrationConnectionScope(
      integration,
      connectionRole,
    );
    const targetUserId = connectionScope === 'deployment' ? null : input.userId;
    const connection = connections.find(
      (candidate) =>
        candidate.mcpId === integration.id &&
        candidate.connectionRole === connectionRole &&
        candidate.userId === targetUserId,
    );
    const enabled = enabledById.get(integration.id) ?? false;
    const authStatus = connection?.enabled
      ? (connection.authStatus ?? null)
      : null;
    const connected =
      integration.supportsKeylessAccess || authStatus === 'authenticated';
    const status = !available
      ? ('unavailable' as const)
      : !enabled
        ? ('not_enabled' as const)
        : connected
          ? ('connected' as const)
          : ('needs_connection' as const);

    return {
      id: integration.id,
      name: integration.name,
      description: integration.description,
      connectionScope,
      setupStrategy: getNativeIntegrationSetupStrategy(integration),
      status,
      enabled,
      authStatus,
      canConnect:
        available &&
        Boolean(user && !user.deletedAt) &&
        (connectionScope === 'user' || user?.role === 'admin'),
    };
  });
}

export async function connectIntegrationForFast(input: {
  userId: string;
  sessionId: string;
  integrationId: string;
}): Promise<ConnectIntegrationResult> {
  const integration = getMcpIntegration(input.integrationId);
  if (!integration) {
    throw new Error(`Unknown built-in integration: ${input.integrationId}`);
  }
  if (areCuratedIntegrationsDisabled(Env.R_CURATED_INTEGRATIONS_DISABLED)) {
    return {
      status: 'unavailable',
      id: integration.id,
      name: integration.name,
    };
  }

  const [user, session] = await Promise.all([
    db.query.users.findFirst({
      where: eq(users.id, input.userId),
      columns: { role: true, deletedAt: true },
    }),
    db.query.sessions.findFirst({
      where: and(
        eq(sessions.id, input.sessionId),
        eq(sessions.ownerKind, 'user'),
        eq(sessions.ownerUserId, input.userId),
      ),
      columns: { id: true, archivedAt: true },
    }),
  ]);
  if (!user || user.deletedAt || !session || session.archivedAt) {
    return {
      status: 'permission_denied',
      id: integration.id,
      name: integration.name,
    };
  }

  const connectionRole = getDefaultMcpConnectionRole(integration);
  const connectionScope = getMcpIntegrationConnectionScope(
    integration,
    connectionRole,
  );
  if (connectionScope === 'deployment' && user.role !== 'admin') {
    return {
      status: 'permission_denied',
      id: integration.id,
      name: integration.name,
    };
  }

  const setupStrategy = getNativeIntegrationSetupStrategy(integration);
  if (setupStrategy === 'keyless') {
    await db
      .insert(deploymentMcpEnablements)
      .values({
        mcpId: integration.id,
        enabled: true,
        enabledByUserId: input.userId,
      })
      .onConflictDoUpdate({
        target: deploymentMcpEnablements.mcpId,
        set: {
          enabled: true,
          enabledByUserId: input.userId,
          updatedAt: new Date(),
        },
      });
    return { status: 'connected', id: integration.id, name: integration.name };
  }

  const targetUserId = connectionScope === 'deployment' ? null : input.userId;
  const connection = await db.query.mcpConnections.findFirst({
    where: and(
      eq(mcpConnections.mcpId, integration.id),
      eq(mcpConnections.connectionRole, connectionRole),
      targetUserId === null
        ? isNull(mcpConnections.userId)
        : eq(mcpConnections.userId, targetUserId),
    ),
    orderBy: (table, { desc }) => [desc(table.createdAt)],
  });
  const hasUsableOauth =
    connection?.authStatus === 'authenticated' &&
    isMcpConnectionOAuthConfig(connection.authConfig) &&
    (await hasValidOAuthTokens(connection.id));
  if (
    connection?.authStatus === 'authenticated' &&
    (hasUsableOauth || !isMcpConnectionOAuthConfig(connection.authConfig))
  ) {
    await db.transaction(async (tx) => {
      await tx
        .update(mcpConnections)
        .set({ enabled: true, updatedAt: new Date() })
        .where(eq(mcpConnections.id, connection.id));
      if (connectionScope === 'deployment') {
        await tx
          .insert(deploymentMcpEnablements)
          .values({
            mcpId: integration.id,
            enabled: true,
            enabledByUserId: input.userId,
          })
          .onConflictDoUpdate({
            target: deploymentMcpEnablements.mcpId,
            set: {
              enabled: true,
              enabledByUserId: input.userId,
              updatedAt: new Date(),
            },
          });
      }
    });
    return { status: 'connected', id: integration.id, name: integration.name };
  }

  const requiredEnvironmentVariables = [
    integration.oauthClientEnv?.clientIdEnv,
    integration.oauthClientEnv?.clientSecretEnv,
  ].filter((key): key is string => Boolean(key));
  const supportsConfiguredOauth =
    setupStrategy === 'oauth' && (await hasConfiguredOauthClient(integration));
  if (supportsConfiguredOauth) {
    return {
      status: 'authorization_required',
      id: integration.id,
      name: integration.name,
      authorizeUrl: await prepareReplay({
        userId: input.userId,
        sessionId: input.sessionId,
        mcpId: integration.id,
        connectionRole,
      }),
    };
  }

  const settingsUrl = publicUrl(
    `/settings/integrations?highlight=${encodeURIComponent(integration.id)}`,
  );
  if (setupStrategy === 'oauth' && requiredEnvironmentVariables.length > 0) {
    return {
      status: 'operator_configuration_required',
      id: integration.id,
      name: integration.name,
      settingsUrl,
      requiredEnvironmentVariables,
    };
  }
  return {
    status: 'configuration_required',
    id: integration.id,
    name: integration.name,
    settingsUrl,
  };
}
