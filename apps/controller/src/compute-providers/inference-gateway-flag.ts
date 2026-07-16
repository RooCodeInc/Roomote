import { isInferenceGatewayEnabledForDeployment } from '@roomote/feature-flags/server';
import { getRedis } from '@roomote/redis';

/**
 * Evaluate the deployment-level InferenceGateway flag for worker spawn env
 * construction. Delegates to the shared fail-closed evaluator so the spawn
 * env and the dequeue env are gated by identical logic.
 */
export async function isInferenceGatewayEnabledForWorkerEnv(): Promise<boolean> {
  return isInferenceGatewayEnabledForDeployment(getRedis(), '[spawn-worker]');
}
