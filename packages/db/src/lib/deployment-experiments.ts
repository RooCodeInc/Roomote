import { eq, sql } from 'drizzle-orm';

import {
  DEPLOYMENT_EXPERIMENT_METADATA_KEYS,
  getDeploymentExperimentValues,
  type DeploymentExperimentId,
  type DeploymentExperimentValues,
} from '@roomote/feature-flags';

import { db, type DatabaseOrTransaction } from '../db';
import { deploymentSettings } from '../schema';

const DEFAULT_DEPLOYMENT_ID = 'default';

export async function getDeploymentExperiments(
  database: DatabaseOrTransaction = db,
): Promise<DeploymentExperimentValues> {
  const settings = await database.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: { metadata: true },
  });

  return getDeploymentExperimentValues(settings?.metadata);
}

export async function isDeploymentExperimentEnabled(
  id: DeploymentExperimentId,
  database: DatabaseOrTransaction = db,
): Promise<boolean> {
  return (await getDeploymentExperiments(database))[id];
}

export async function isDeploymentExperimentEnabledWithShareLock(
  id: DeploymentExperimentId,
  database: DatabaseOrTransaction,
): Promise<boolean> {
  const [settings] = await database
    .select({ metadata: deploymentSettings.metadata })
    .from(deploymentSettings)
    .where(eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID))
    .for('share');

  return getDeploymentExperimentValues(settings?.metadata)[id];
}

export async function setDeploymentExperimentEnabled(
  id: DeploymentExperimentId,
  enabled: boolean,
  database: DatabaseOrTransaction = db,
): Promise<DeploymentExperimentValues> {
  const metadata = {
    [DEPLOYMENT_EXPERIMENT_METADATA_KEYS[id]]: enabled,
  };

  await database
    .insert(deploymentSettings)
    .values({ id: DEFAULT_DEPLOYMENT_ID, metadata, setupCompletedAt: null })
    .onConflictDoUpdate({
      target: deploymentSettings.id,
      set: {
        metadata: sql`${deploymentSettings.metadata} || ${JSON.stringify(metadata)}::jsonb`,
        updatedAt: new Date(),
      },
    });

  return getDeploymentExperiments(database);
}
