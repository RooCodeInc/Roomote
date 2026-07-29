import {
  db,
  resolveDeploymentEnvVar,
  type DatabaseOrTransaction,
} from '@roomote/db/server';
import type { McpIntegration } from '@roomote/types';

import {
  getStaticOauthEnvKeys,
  getStaticOauthReadiness,
  resolveStaticOauthClientInformation,
} from './mcp-static-oauth';

async function resolveDeploymentStaticOauthEnv(
  runtimeEnv: unknown,
  integration: Pick<McpIntegration, 'id' | 'oauthClientEnv'>,
  executor: DatabaseOrTransaction = db,
): Promise<Record<string, string>> {
  const keys = getStaticOauthEnvKeys(integration);
  const runtimeRecord =
    typeof runtimeEnv === 'object' && runtimeEnv !== null
      ? (runtimeEnv as Partial<Record<string, string | undefined>>)
      : {};
  const entries = await Promise.all(
    keys.map(async (key) => {
      const value = await resolveDeploymentEnvVar(key, executor, runtimeRecord);
      return value ? ([key, value] as const) : null;
    }),
  );

  return Object.fromEntries(entries.filter((entry) => entry !== null));
}

export async function getDeploymentStaticOauthReadiness(
  runtimeEnv: unknown,
  integration: Pick<McpIntegration, 'id' | 'oauthClientEnv'>,
  executor: DatabaseOrTransaction = db,
) {
  const resolvedEnv = await resolveDeploymentStaticOauthEnv(
    runtimeEnv,
    integration,
    executor,
  );

  return getStaticOauthReadiness(resolvedEnv, integration);
}

export async function resolveDeploymentStaticOauthClientInformation(
  runtimeEnv: unknown,
  integration: Pick<McpIntegration, 'id' | 'oauthClientEnv'>,
  executor: DatabaseOrTransaction = db,
) {
  const resolvedEnv = await resolveDeploymentStaticOauthEnv(
    runtimeEnv,
    integration,
    executor,
  );

  return resolveStaticOauthClientInformation(resolvedEnv, integration);
}
