import { eq } from 'drizzle-orm';
import {
  communicationProviderSchema,
  type CommunicationProvider,
} from '@roomote/types';

import { type DatabaseOrTransaction, db } from '../db';
import { deploymentSettings } from '../schema';

const DEFAULT_DEPLOYMENT_ID = 'default';
const SLACK_CHANNEL_ID_REGEX = /^[CG][A-Z0-9]{8,}$/i;

export type RouterDebugChannelSource =
  | 'deployment'
  | 'env'
  | 'disabled'
  | 'none';

export type RouterDebugDestination = {
  provider: CommunicationProvider;
  channelId: string;
};

export function normalizeRouterDebugSlackChannelId(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();

  if (!trimmed || !SLACK_CHANNEL_ID_REGEX.test(trimmed)) {
    return null;
  }

  return trimmed.toUpperCase();
}

export function normalizeRouterDebugDestination(
  value: Partial<RouterDebugDestination> | null | undefined,
): RouterDebugDestination | null {
  const provider = communicationProviderSchema.safeParse(value?.provider);
  const channelId = value?.channelId?.trim();

  if (!provider.success || !channelId) {
    return null;
  }

  const normalizedChannelId =
    provider.data === 'slack'
      ? normalizeRouterDebugSlackChannelId(channelId)
      : channelId;

  if (!normalizedChannelId) {
    return null;
  }

  return {
    provider: provider.data,
    channelId: normalizedChannelId,
  };
}

export async function getRouterDebugSettings(
  options: {
    executor?: DatabaseOrTransaction;
    runtimeEnv?: Pick<NodeJS.ProcessEnv, 'ROUTER_DEBUG_CHANNEL_ID'>;
  } = {},
): Promise<{
  destination: RouterDebugDestination | null;
  disabled: boolean;
  routerDebugSlackChannelId: string | null;
  envFallbackSlackChannelId: string | null;
  effectiveRouterDebugSlackChannelId: string | null;
  source: RouterDebugChannelSource;
}> {
  const executor = options.executor ?? db;
  const deployment = await executor.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: {
      routerDebugProvider: true,
      routerDebugChannelId: true,
      routerDebugDisabled: true,
      routerDebugSlackChannelId: true,
    },
  });

  const legacySlackChannelId = normalizeRouterDebugSlackChannelId(
    deployment?.routerDebugSlackChannelId,
  );
  const envFallbackSlackChannelId = normalizeRouterDebugSlackChannelId(
    (options.runtimeEnv ?? process.env).ROUTER_DEBUG_CHANNEL_ID,
  );
  const deploymentDestination = normalizeRouterDebugDestination({
    provider: deployment?.routerDebugProvider as
      | CommunicationProvider
      | undefined,
    channelId: deployment?.routerDebugChannelId ?? undefined,
  });
  const disabled = deployment?.routerDebugDisabled === true;
  const destination = disabled
    ? null
    : (deploymentDestination ??
      (legacySlackChannelId
        ? { provider: 'slack' as const, channelId: legacySlackChannelId }
        : envFallbackSlackChannelId
          ? { provider: 'slack' as const, channelId: envFallbackSlackChannelId }
          : null));

  return {
    destination,
    disabled,
    envFallbackSlackChannelId,
    routerDebugSlackChannelId: legacySlackChannelId,
    effectiveRouterDebugSlackChannelId:
      destination?.provider === 'slack' ? destination.channelId : null,
    source: disabled
      ? 'disabled'
      : deploymentDestination || legacySlackChannelId
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
  return settings.destination?.provider === 'slack'
    ? settings.destination.channelId
    : null;
}

export async function getConfiguredRouterDebugDestination(
  options: {
    executor?: DatabaseOrTransaction;
    runtimeEnv?: Pick<NodeJS.ProcessEnv, 'ROUTER_DEBUG_CHANNEL_ID'>;
  } = {},
): Promise<RouterDebugDestination | null> {
  return (await getRouterDebugSettings(options)).destination;
}

export async function updateRouterDebugSettings(
  input: {
    destination: RouterDebugDestination | null;
    disabled?: boolean;
  },
  options: {
    executor?: DatabaseOrTransaction;
  } = {},
): Promise<void> {
  const executor = options.executor ?? db;
  const destination = normalizeRouterDebugDestination(input.destination);
  const disabled = input.disabled === true;
  const now = new Date();

  await executor
    .insert(deploymentSettings)
    .values({
      id: DEFAULT_DEPLOYMENT_ID,
      routerDebugProvider: destination?.provider ?? null,
      routerDebugChannelId: destination?.channelId ?? null,
      routerDebugDisabled: disabled,
      routerDebugSlackChannelId:
        destination?.provider === 'slack' ? destination.channelId : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: deploymentSettings.id,
      set: {
        routerDebugProvider: destination?.provider ?? null,
        routerDebugChannelId: destination?.channelId ?? null,
        routerDebugDisabled: disabled,
        routerDebugSlackChannelId:
          destination?.provider === 'slack' ? destination.channelId : null,
        updatedAt: now,
      },
    });
}
