import { db, deploymentSettings, eq } from '@roomote/db/server';

import { evaluateFeatureFlagFromMetadata } from '../index';
import type { FeatureFlag } from '../types';

const DEFAULT_DEPLOYMENT_ID = 'default';

/**
 * Evaluates a deployment-wide flag without requiring Redis. Runtime write
 * paths use this when cache availability must not gate task or Session writes.
 */
export async function evaluateDeploymentFeatureFlag(
  flag: FeatureFlag,
): Promise<boolean> {
  const deployment = await db.query.deploymentSettings.findFirst({
    where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
    columns: { metadata: true },
  });

  return evaluateFeatureFlagFromMetadata(flag, deployment?.metadata);
}
