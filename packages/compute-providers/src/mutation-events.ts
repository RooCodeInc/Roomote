import type {
  RunEventDetails,
  ComputeProviderLaunchMode,
} from '@roomote/types';

export interface ComputeProviderMutationLifecycleContext {
  attempt?: number;
  launchMode?: ComputeProviderLaunchMode | null;
  sourceSnapshotId?: string | null;
  ports?: number[];
}

export function buildComputeProviderMutationDetails(
  context: ComputeProviderMutationLifecycleContext,
  details: RunEventDetails = {},
): RunEventDetails {
  return {
    ...(context.attempt != null ? { attempt: context.attempt } : {}),
    ...(context.launchMode ? { launchMode: context.launchMode } : {}),
    sourceSnapshotId: context.sourceSnapshotId ?? null,
    ports: context.ports ?? [],
    ...details,
  };
}
