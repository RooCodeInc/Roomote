import { eq, sql } from 'drizzle-orm';

import {
  integrationToolAutoSettingsSchema,
  type IntegrationToolAutoSettings,
} from '@roomote/types';

import { type DatabaseOrTransaction, db } from '../db';
import { deploymentSettings } from '../schema';

const DEFAULT_DEPLOYMENT_ID = 'default';
const METADATA_KEY = 'integration_tool_auto_nightly';
const LEGACY_METADATA_KEY = 'integration_tool_auto';

/**
 * Deployment-wide Auto settings for tool approvals, kept with the other
 * deployment settings: the guidance every assessment reads. Auto itself is
 * turned on per session by its owner (`setIntegrationToolAutoForSession`), so
 * the stored mode decides nothing; it stays as saved for N-1 rollback
 * compatibility. The nightly key intentionally does not inherit the
 * customer-preview key's mode.
 */
const DEFAULTS: IntegrationToolAutoSettings = { mode: 'off', policy: '' };

export async function getIntegrationToolAutoSettings(
  database: DatabaseOrTransaction = db,
): Promise<IntegrationToolAutoSettings> {
  const deployment = await database.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: { metadata: true },
  });
  const metadata = deployment?.metadata as Record<string, unknown> | null;
  const current = integrationToolAutoSettingsSchema.safeParse(
    metadata?.[METADATA_KEY],
  );
  if (current.success) return current.data;

  const legacy = integrationToolAutoSettingsSchema.safeParse(
    metadata?.[LEGACY_METADATA_KEY],
  );
  return legacy.success
    ? { mode: 'off', policy: legacy.data.policy }
    : DEFAULTS;
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
