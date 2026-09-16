import { eq, sql } from 'drizzle-orm';

import { db } from '../db';
import { deploymentSettings } from '../schema';

const DEFAULT_DEPLOYMENT_ID = 'default';

export const PRIVATE_SESSIONS_EXPERIMENT_METADATA_KEY =
  'private_sessions_experiment_enabled';

export function isPrivateSessionsExperimentEnabledInMetadata(
  metadata: unknown,
): boolean {
  return (
    Boolean(metadata) &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>)[
      PRIVATE_SESSIONS_EXPERIMENT_METADATA_KEY
    ] === true
  );
}

export async function isPrivateSessionsExperimentEnabled(): Promise<boolean> {
  const settings = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: { metadata: true },
  });
  return isPrivateSessionsExperimentEnabledInMetadata(settings?.metadata);
}

export async function setPrivateSessionsExperimentEnabled(
  enabled: boolean,
): Promise<void> {
  const metadata = { [PRIVATE_SESSIONS_EXPERIMENT_METADATA_KEY]: enabled };
  await db
    .insert(deploymentSettings)
    .values({ id: DEFAULT_DEPLOYMENT_ID, metadata, setupCompletedAt: null })
    .onConflictDoUpdate({
      target: deploymentSettings.id,
      set: {
        metadata: sql`${deploymentSettings.metadata} || ${JSON.stringify(metadata)}::jsonb`,
        updatedAt: new Date(),
      },
    });
}
