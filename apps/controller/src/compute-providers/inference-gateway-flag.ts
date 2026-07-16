import {
  FeatureFlag,
  getFeatureFlagEvaluator,
} from '@roomote/feature-flags/server';
import { getRedis } from '@roomote/redis';

/**
 * Evaluate the deployment-level InferenceGateway flag for worker spawn env
 * construction. Fails closed (provider keys ship to the worker daemon as
 * before) when flag evaluation is unavailable, so a Redis outage cannot
 * break task inference.
 */
export async function isInferenceGatewayEnabledForWorkerEnv(): Promise<boolean> {
  try {
    return await getFeatureFlagEvaluator(getRedis()).evaluate(
      FeatureFlag.InferenceGateway,
      { isDeploymentContext: true },
    );
  } catch (error) {
    console.warn(
      `[spawn-worker] InferenceGateway flag evaluation failed; forwarding provider keys: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );

    return false;
  }
}
