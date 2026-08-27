import { db, deploymentSettings, eq } from '@roomote/db/server';

import { evaluateFeatureFlagFromMetadata } from '../index';
import type { FeatureFlag } from '../types';

const DEFAULT_DEPLOYMENT_ID = 'default';
const DEPLOYMENT_METADATA_CACHE_TTL_MS = 30_000;

let cachedDeploymentMetadata: { value: unknown; expiresAt: number } | null =
  null;
let pendingDeploymentMetadata: Promise<unknown> | null = null;
let cacheGeneration = 0;

export function invalidateDeploymentFeatureFlagCache(): void {
  cachedDeploymentMetadata = null;
  pendingDeploymentMetadata = null;
  cacheGeneration += 1;
}

async function getDeploymentMetadata(): Promise<unknown> {
  if (
    cachedDeploymentMetadata &&
    cachedDeploymentMetadata.expiresAt > Date.now()
  ) {
    return cachedDeploymentMetadata.value;
  }

  if (pendingDeploymentMetadata) {
    return pendingDeploymentMetadata;
  }

  const generation = cacheGeneration;
  const request = db.query.deploymentSettings
    .findFirst({
      where: eq(deploymentSettings.id, DEFAULT_DEPLOYMENT_ID),
      columns: { metadata: true },
    })
    .then((deployment) => {
      const value = deployment?.metadata;
      if (cacheGeneration === generation) {
        cachedDeploymentMetadata = {
          value,
          expiresAt: Date.now() + DEPLOYMENT_METADATA_CACHE_TTL_MS,
        };
      }
      return value;
    })
    .finally(() => {
      if (pendingDeploymentMetadata === request) {
        pendingDeploymentMetadata = null;
      }
    });
  pendingDeploymentMetadata = request;

  return request;
}

/**
 * Evaluates a deployment-wide flag without requiring Redis. Runtime write
 * paths use this when cache availability must not gate task or Session writes.
 */
export async function evaluateDeploymentFeatureFlag(
  flag: FeatureFlag,
): Promise<boolean> {
  return evaluateFeatureFlagFromMetadata(flag, await getDeploymentMetadata());
}
