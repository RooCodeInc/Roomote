import {
  type ComputeProvider,
  type EnvironmentConfig,
  hasEnvironmentOidcTargets,
} from '@roomote/types';
import { primeSandboxOidcTargets } from '@roomote/sdk/server';

export async function primeEnvironmentOidcForMachine(params: {
  taskId?: string;
  environmentId: string;
  environmentConfig: EnvironmentConfig | undefined;
  computeProvider: ComputeProvider;
  computeProviderId: string;
  runId?: number;
  context: string;
}): Promise<void> {
  if (!params.environmentConfig) {
    return;
  }

  if (!hasEnvironmentOidcTargets(params.environmentConfig)) {
    return;
  }

  await primeSandboxOidcTargets({
    taskId: params.taskId,
    environmentId: params.environmentId,
    environmentConfig: params.environmentConfig,
    computeProvider: params.computeProvider,
    computeProviderId: params.computeProviderId,
    runId: params.runId,
  });
}
