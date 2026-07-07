import {
  type FeatureFlag,
  getFeatureFlagEvaluator,
} from '@roomote/feature-flags/server';
import { getRedis } from '@roomote/redis';

export async function resolveFeatureFlagForUser(
  flag: FeatureFlag,
  tag: string,
): Promise<boolean> {
  try {
    return await getFeatureFlagEvaluator(getRedis()).evaluate(flag, {
      isDeploymentContext: true,
    });
  } catch (error) {
    console.warn(
      `${tag} Failed to evaluate ${flag} feature flag: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return false;
  }
}
