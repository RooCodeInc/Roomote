import type { ComputeUsageObservation } from '@roomote/compute-providers';
import { recordComputeProviderUsage } from '@roomote/sdk/server';
import type { ComputeProviderUsageLifecycleAction } from '@roomote/types';

export async function tryRecordComputeProviderUsage(input: {
  cloudJobId: number;
  lifecycleAction: ComputeProviderUsageLifecycleAction;
  completedAt: Date;
  usageObservation?: ComputeUsageObservation;
  details?: Record<string, unknown>;
  logPrefix: string;
}): Promise<void> {
  try {
    await recordComputeProviderUsage({
      cloudJobId: input.cloudJobId,
      lifecycleAction: input.lifecycleAction,
      completedAt: input.completedAt,
      activeCpuDurationMs: input.usageObservation?.activeCpuDurationMs,
      networkIngressBytes: input.usageObservation?.networkTransfer?.ingress,
      networkEgressBytes: input.usageObservation?.networkTransfer?.egress,
      details: input.details,
    });
  } catch (error) {
    console.warn(
      `[${input.logPrefix}] Failed to record compute provider usage for job #${input.cloudJobId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
