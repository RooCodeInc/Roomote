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

export async function cleanupAzureInstance(options: {
  computeClient: Pick<
    ComputeProviderClient,
    'destroyInstance' | 'enterStandby'
  >;
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
  // Standby resume reuses the original task filesystem. Cleanup must never
  // delete that retained instance, including when re-suspension fails.
  const retained = options.launchMode === 'task_standby';
  const operation = retained ? 'enter_standby' : 'destroy_instance';
  const method = retained ? 'enterStandby' : 'destroyInstance';
  const mutationDetails = buildComputeProviderMutationDetails(
    {
      launchMode: options.launchMode,
      sourceSnapshotId: options.sourceSnapshotId,
      ports: options.ports,
    },
    { phase, reason },
  );

  console.warn(`[${logPrefix}] Cleaning up Azure instance after ${reason}`, {
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
      provider: 'azure',
      operation,
      eventType: 'started',
      instanceId,
      message: `Calling ${method} for Azure instance ${instanceId}.`,
      details: mutationDetails,
    });

    if (retained) {
      if (!computeClient.enterStandby) {
        throw new Error(
          'Azure client cannot restore standby; retained sandbox has not been deleted',
        );
      }
      // Cleanup must still run after a cancelled bootstrap, so do not reuse its
      // aborted signal. A failed stop is reported without a destructive fallback.
      await computeClient.enterStandby({ instanceId });
    } else {
      await computeClient.destroyInstance({ instanceId });
    }

    await onMutation?.({
      provider: 'azure',
      operation,
      eventType: 'completed',
      instanceId,
      message: `${method} completed for Azure instance ${instanceId}.`,
      details: mutationDetails,
    });

    console.log(`[${logPrefix}] Cleaned up Azure instance`, {
      instanceId,
      phase,
      reason,
    });
  } catch (cleanupError) {
    await onMutation?.({
      provider: 'azure',
      operation,
      eventType: 'failed',
      instanceId,
      message: `${method} failed for Azure instance ${instanceId}.`,
      details: {
        ...mutationDetails,
        error:
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError),
      },
    });

    console.error(`[${logPrefix}] Failed to clean up Azure instance`, {
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
