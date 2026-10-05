import { eq } from 'drizzle-orm';

import { isEmailChannelEnabled } from '@roomote/env';

import { type DatabaseOrTransaction, db } from '../db';
import { deploymentSettings } from '../schema';

const DEFAULT_DEPLOYMENT_ID = 'default';

export type AgentMailOutboundSettings = {
  environmentEnabled: boolean;
  persistedEnabled: boolean;
  effectiveEnabled: boolean;
};

export async function getAgentMailOutboundSettings(
  options: { executor?: DatabaseOrTransaction } = {},
): Promise<AgentMailOutboundSettings> {
  const environmentEnabled = isEmailChannelEnabled();
  const executor = options.executor ?? db;
  const deployment = await executor.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: { emailOutboundEnabled: true },
  });
  const persistedEnabled = deployment?.emailOutboundEnabled ?? true;

  return {
    environmentEnabled,
    persistedEnabled,
    effectiveEnabled: environmentEnabled && persistedEnabled,
  };
}

export async function isAgentMailOutboundEnabled(
  options: { executor?: DatabaseOrTransaction } = {},
): Promise<boolean> {
  if (!isEmailChannelEnabled()) {
    return false;
  }

  return (await getAgentMailOutboundSettings(options)).persistedEnabled;
}

export async function setAgentMailOutboundEnabled(
  enabled: boolean,
  options: { executor?: DatabaseOrTransaction } = {},
): Promise<boolean> {
  const executor = options.executor ?? db;

  await executor
    .insert(deploymentSettings)
    .values({ id: DEFAULT_DEPLOYMENT_ID, emailOutboundEnabled: enabled })
    .onConflictDoUpdate({
      target: deploymentSettings.id,
      set: { emailOutboundEnabled: enabled, updatedAt: new Date() },
    });

  return enabled;
}
