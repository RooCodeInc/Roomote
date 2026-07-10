import type { ComputeUsageObservation } from '@roomote/compute-providers';
import { recordComputeProviderUsage } from '@roomote/sdk/server';
import type { ComputeProviderUsageLifecycleAction } from '@roomote/types';

export async function tryRecordComputeProviderUsage(input: {
  runId: number;
  lifecycleAction: ComputeProviderUsageLifecycleAction;
  completedAt: Date;
  usageObservation?: ComputeUsageObservation;
  details?: Record<string, unknown>;
  logPrefix: string;
}): Promise<void> {
  try {
    await recordComputeProviderUsage({
      // The SDK recorder still keys its input on `cloudJobId`; it persists to
      // compute_provider_usage.run_id.
      cloudJobId: input.runId,
      lifecycleAction: input.lifecycleAction,
      completedAt: input.completedAt,
      activeCpuDurationMs: input.usageObservation?.activeCpuDurationMs,
      networkIngressBytes: input.usageObservation?.networkTransfer?.ingress,
      networkEgressBytes: input.usageObservation?.networkTransfer?.egress,
      details: input.details,
    });
  } catch (error) {
    console.warn(
      `[${input.logPrefix}] Failed to record compute provider usage for run #${input.runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
