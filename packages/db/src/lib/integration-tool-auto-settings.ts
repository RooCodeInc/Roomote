import { eq, sql } from 'drizzle-orm';

import {
  integrationToolAutoSettingsSchema,
  type IntegrationToolAutoSettings,
} from '@roomote/types';

import { type DatabaseOrTransaction, db } from '../db';
import { deploymentSettings } from '../schema';

const DEFAULT_DEPLOYMENT_ID = 'default';
const METADATA_KEY = 'integration_tool_auto';

/**
 * Deployment-wide Auto mode for tool approvals, kept with the other
 * deployment settings. Off by default: default tools run as they always
 * have until an admin turns Auto on.
 */
const DEFAULTS: IntegrationToolAutoSettings = { mode: 'off', policy: '' };

export async function getIntegrationToolAutoSettings(
  database: DatabaseOrTransaction = db,
): Promise<IntegrationToolAutoSettings> {
  const deployment = await database.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: { metadata: true },
  });
  const parsed = integrationToolAutoSettingsSchema.safeParse(
    (deployment?.metadata as Record<string, unknown> | null)?.[METADATA_KEY],
  );
  return parsed.success ? parsed.data : DEFAULTS;
}

export async function setIntegrationToolAutoSettings(
  settings: IntegrationToolAutoSettings,
  database: DatabaseOrTransaction = db,
): Promise<IntegrationToolAutoSettings> {
  await database
    .insert(deploymentSettings)
    .values({
      id: DEFAULT_DEPLOYMENT_ID,
      metadata: { [METADATA_KEY]: settings },
      setupCompletedAt: null,
    })
    .onConflictDoUpdate({
      target: deploymentSettings.id,
      set: {
        metadata: sql`${deploymentSettings.metadata} || ${JSON.stringify({ [METADATA_KEY]: settings })}::jsonb`,
        updatedAt: new Date(),
      },
    });
  return settings;
}
