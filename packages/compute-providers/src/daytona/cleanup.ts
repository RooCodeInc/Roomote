import type {
  ComputeProviderClient,
  ComputeProviderMutationObserver,
} from '../types';
import { buildComputeProviderMutationDetails } from '../mutation-events';
import type { ComputeProviderLaunchMode } from '@roomote/types';

import { isAbortError } from '../modal/abort';

function resolveCleanupReason(error: unknown): 'abort' | 'error' {
  return isAbortError(error) ? 'abort' : 'error';
}

export async function cleanupDaytonaInstance(options: {
  computeClient: Pick<ComputeProviderClient, 'destroyInstance'>;
  instanceId: string;
  phase: string;
  error: unknown;
  logPrefix: string;
  onMutation?: ComputeProviderMutationObserver;
  launchMode?: ComputeProviderLaunchMode | null;
  sourceSnapshotId?: string | null;
  ports?: number[];
}): Promise<void> {
  const { computeClient, instanceId, phase, error, logPrefix, onMutation } =
    options;
  const reason = resolveCleanupReason(error);
  const mutationDetails = buildComputeProviderMutationDetails(
    {
      launchMode: options.launchMode,
      sourceSnapshotId: options.sourceSnapshotId,
      ports: options.ports,
    },
    { phase, reason },
  );

  console.warn(`[${logPrefix}] Cleaning up Daytona instance after ${reason}`, {
    instanceId,
    phase,
    error:
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            stack: error.stack,
          }
        : { message: String(error) },
  });

  try {
    await onMutation?.({
      provider: 'daytona',
      operation: 'destroy_instance',
      eventType: 'started',
      instanceId,
      message: `Calling destroyInstance for Daytona instance ${instanceId}.`,
      details: mutationDetails,
    });

    await computeClient.destroyInstance({ instanceId });

    await onMutation?.({
      provider: 'daytona',
      operation: 'destroy_instance',
      eventType: 'completed',
      instanceId,
      message: `destroyInstance completed for Daytona instance ${instanceId}.`,
      details: mutationDetails,
    });

    console.log(`[${logPrefix}] Cleaned up Daytona instance`, {
      instanceId,
      phase,
      reason,
    });
  } catch (cleanupError) {
    await onMutation?.({
      provider: 'daytona',
      operation: 'destroy_instance',
      eventType: 'failed',
      instanceId,
      message: `destroyInstance failed for Daytona instance ${instanceId}.`,
      details: {
        ...mutationDetails,
        error:
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError),
      },
    });

    console.error(`[${logPrefix}] Failed to clean up Daytona instance`, {
      instanceId,
      phase,
      reason,
      cleanupError:
        cleanupError instanceof Error
          ? {
              name: cleanupError.name,
              message: cleanupError.message,
              stack: cleanupError.stack,
            }
          : { message: String(cleanupError) },
    });
  }
}
