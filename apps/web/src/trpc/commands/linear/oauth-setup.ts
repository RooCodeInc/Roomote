import {
  and,
  db,
  deploymentMcpEnablements,
  eq,
  isNull,
  mcpConnections,
  resolveDeploymentEnvVar,
  type DatabaseOrTransaction,
} from '@roomote/db/server';
import { LINEAR_ORG_CONNECTION_ROLE } from '@roomote/sdk/server';

import { Env } from '@/lib/server/env';
import { getPublicAppUrl } from '@/lib/server/get-public-app-url';
import type { UserAuthSuccess } from '@/types';

import { upsertDeploymentEnvironmentVariables } from '../environment-variables';

const LINEAR_OAUTH_ENV_FIELDS = {
  clientId: 'R_LINEAR_CLIENT_ID',
  clientSecret: 'R_LINEAR_CLIENT_SECRET',
  webhookSecret: 'R_LINEAR_WEBHOOK_SECRET',
} as const;

type LinearOauthSetupField = keyof typeof LINEAR_OAUTH_ENV_FIELDS;

type SaveLinearOauthSetupInput = Record<LinearOauthSetupField, string>;

function assertAdmin(auth: Pick<UserAuthSuccess, 'isAdmin'>) {
  if (!auth.isAdmin) {
    throw new Error('Unauthorized');
  }
}

function getRuntimeEnvValue(name: string): string | null {
  const value = (Env as unknown as Record<string, unknown>)[name];
  if (typeof value !== 'string') {
    return null;
  }

  const normalizedValue = value.trim();
  return normalizedValue || null;
}

function getLinearRuntimeEnv(): Partial<Record<string, string | undefined>> {
  return Object.fromEntries(
    Object.values(LINEAR_OAUTH_ENV_FIELDS).flatMap((envName) => {
      const value = getRuntimeEnvValue(envName);
      return value ? [[envName, value]] : [];
    }),
  );
}

function buildLinearOauthSetup(publicOrigin: string) {
  const callbackUrl = new URL(
    '/api/mcp-oauth/callback',
    publicOrigin,
  ).toString();
  const webhookUrl = new URL('/api/webhooks/linear', publicOrigin).toString();
  const manifest = {
    $schema: 'https://linear.app/.well-known/oauth-app-manifest.schema.json',
    schemaVersion: '1.0.0',
    distribution: 'private',
    display: {
      description:
        'Run Roomote agents from Linear issues and keep progress in sync.',
    },
    developer: { name: 'Roomote' },
    oauth: {
      client_name: 'Roomote',
      client_uri: publicOrigin,
      redirect_uris: [callbackUrl],
      grant_types: ['authorization_code'],
    },
    webhook: {
      enabled: true,
      url: webhookUrl,
      resourceTypes: ['AgentSessionEvent'],
    },
  };
  const url = new URL('https://linear.app/settings/api/applications/new');
  url.searchParams.set('manifest', JSON.stringify(manifest));
  return {
    callbackUrl,
    webhookUrl,
    manifestUrl: url.toString(),
  };
}

export async function clearLinearDeploymentConnection(
  executor: DatabaseOrTransaction,
  userId: string,
): Promise<boolean> {
  const deletedConnections = await executor
    .delete(mcpConnections)
    .where(
      and(
        eq(mcpConnections.mcpId, 'linear'),
        eq(mcpConnections.connectionRole, LINEAR_ORG_CONNECTION_ROLE),
        isNull(mcpConnections.userId),
      ),
    )
    .returning({ id: mcpConnections.id });

  await executor
    .insert(deploymentMcpEnablements)
    .values({
      mcpId: 'linear',
      enabled: false,
      enabledByUserId: userId,
    })
    .onConflictDoUpdate({
      target: deploymentMcpEnablements.mcpId,
      set: {
        enabled: false,
        enabledByUserId: userId,
        updatedAt: new Date(),
      },
    });

  return deletedConnections.length > 0;
}

export async function getLinearOauthSetupCommand(auth: UserAuthSuccess) {
  assertAdmin(auth);

  const publicOrigin = getPublicAppUrl(Env);
  const runtimeEnv = getLinearRuntimeEnv();
  const urls = buildLinearOauthSetup(publicOrigin);
  const fieldEntries = await Promise.all(
    Object.entries(LINEAR_OAUTH_ENV_FIELDS).map(async ([field, envName]) => {
      const runtimeValue = getRuntimeEnvValue(envName);
      const effectiveValue = await resolveDeploymentEnvVar(
        envName,
        db,
        runtimeEnv,
      );

      return [
        field,
        {
          configured: Boolean(effectiveValue),
          managedByEnvironment: Boolean(runtimeValue),
        },
      ] as const;
    }),
  );

  return {
    ...urls,
    fields: Object.fromEntries(fieldEntries) as Record<
      LinearOauthSetupField,
      { configured: boolean; managedByEnvironment: boolean }
    >,
  };
}

export async function saveLinearOauthSetupCommand(
  auth: UserAuthSuccess,
  input: SaveLinearOauthSetupInput,
) {
  assertAdmin(auth);
  const runtimeEnv = getLinearRuntimeEnv();

  const currentValues = await Promise.all(
    Object.entries(LINEAR_OAUTH_ENV_FIELDS).map(async ([field, envName]) => [
      field,
      await resolveDeploymentEnvVar(envName, db, runtimeEnv),
    ]),
  );
  const currentByField = Object.fromEntries(currentValues) as Record<
    LinearOauthSetupField,
    string | null
  >;
  const labels: Record<LinearOauthSetupField, string> = {
    clientId: 'client ID',
    clientSecret: 'client secret',
    webhookSecret: 'webhook secret',
  };
  const missingFields = (
    Object.keys(LINEAR_OAUTH_ENV_FIELDS) as LinearOauthSetupField[]
  ).filter((field) => !input[field].trim() && !currentByField[field]);

  if (missingFields.length > 0) {
    throw new Error(
      `Enter the Linear ${missingFields.map((field) => labels[field]).join(', ')}.`,
    );
  }

  const values = (
    Object.entries(LINEAR_OAUTH_ENV_FIELDS) as Array<
      [LinearOauthSetupField, string]
    >
  ).flatMap(([field, envName]) => {
    const value = input[field].trim();
    return value && !getRuntimeEnvValue(envName)
      ? [{ name: envName, value }]
      : [];
  });
  const clientCredentialsChanged = (['clientId', 'clientSecret'] as const).some(
    (field) => {
      const value = input[field].trim();
      const envName = LINEAR_OAUTH_ENV_FIELDS[field];
      return (
        Boolean(value) &&
        !getRuntimeEnvValue(envName) &&
        value !== currentByField[field]
      );
    },
  );
  let requiresReconnect = false;

  await db.transaction(async (tx) => {
    await upsertDeploymentEnvironmentVariables(tx, {
      userId: auth.userId,
      values,
    });

    if (clientCredentialsChanged) {
      requiresReconnect = await clearLinearDeploymentConnection(
        tx,
        auth.userId,
      );
    }
  });

  return { success: true as const, requiresReconnect };
}
