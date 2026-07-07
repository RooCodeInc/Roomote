import { eq } from 'drizzle-orm';

import { type DatabaseOrTransaction, db } from '../db';
import { deploymentSettings } from '../schema';

const DEFAULT_DEPLOYMENT_ID = 'default';
const SLACK_CHANNEL_ID_REGEX = /^[CG][A-Z0-9]{8,}$/i;

export type RouterDebugChannelSource = 'deployment' | 'env' | 'none';

export function normalizeRouterDebugSlackChannelId(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();

  if (!trimmed || !SLACK_CHANNEL_ID_REGEX.test(trimmed)) {
    return null;
  }

  return trimmed.toUpperCase();
}

export async function getRouterDebugSettings(
  options: {
    executor?: DatabaseOrTransaction;
    runtimeEnv?: Pick<NodeJS.ProcessEnv, 'ROUTER_DEBUG_CHANNEL_ID'>;
  } = {},
): Promise<{
  routerDebugSlackChannelId: string | null;
  envFallbackSlackChannelId: string | null;
  effectiveRouterDebugSlackChannelId: string | null;
  source: RouterDebugChannelSource;
}> {
  const executor = options.executor ?? db;
  const deployment = await executor.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: {
      routerDebugSlackChannelId: true,
    },
  });

  const routerDebugSlackChannelId = normalizeRouterDebugSlackChannelId(
    deployment?.routerDebugSlackChannelId,
  );
  const envFallbackSlackChannelId = normalizeRouterDebugSlackChannelId(
    (options.runtimeEnv ?? process.env).ROUTER_DEBUG_CHANNEL_ID,
  );
  const effectiveRouterDebugSlackChannelId =
    routerDebugSlackChannelId ?? envFallbackSlackChannelId;

  return {
    routerDebugSlackChannelId,
    envFallbackSlackChannelId,
    effectiveRouterDebugSlackChannelId,
    source: routerDebugSlackChannelId
      ? 'deployment'
      : envFallbackSlackChannelId
        ? 'env'
        : 'none',
  };
}

export async function getConfiguredRouterDebugSlackChannelId(
  options: {
    executor?: DatabaseOrTransaction;
    runtimeEnv?: Pick<NodeJS.ProcessEnv, 'ROUTER_DEBUG_CHANNEL_ID'>;
  } = {},
): Promise<string | null> {
  const settings = await getRouterDebugSettings(options);
  return settings.effectiveRouterDebugSlackChannelId;
}

export async function updateRouterDebugSettings(
  input: {
    routerDebugSlackChannelId: string | null;
  },
  options: {
    executor?: DatabaseOrTransaction;
  } = {},
): Promise<void> {
  const executor = options.executor ?? db;
  const routerDebugSlackChannelId = normalizeRouterDebugSlackChannelId(
    input.routerDebugSlackChannelId,
  );
  const now = new Date();

  await executor
    .insert(deploymentSettings)
    .values({
      id: DEFAULT_DEPLOYMENT_ID,
      routerDebugSlackChannelId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: deploymentSettings.id,
      set: {
        routerDebugSlackChannelId,
        updatedAt: now,
      },
    });
}
