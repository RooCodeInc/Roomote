import type { ComputeProvider } from '@roomote/types';
import {
  and,
  asc,
  computeProviderUsageSamples,
  db,
  eq,
} from '@roomote/db/server';

const BYTES_PER_MIB = 1024 * 1024;

const NS_PER_MS = 1_000_000;

function clampOptionalInteger(value: number | null | undefined): number | null {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return null;
  }

  return Math.max(0, Math.trunc(numericValue));
}

interface RecordComputeProviderUsageSampleInput {
  provider: ComputeProvider;
  providerUsageId: string;
  runId: number;
  taskId: string | null;
  instanceId: string | null;
  sampledAt: Date;
  cpuUsageNsTotal?: number | null;
  memoryUsageBytes?: number | null;
  memoryPeakUsageBytes?: number | null;
  details?: Record<string, unknown> | null;
}

interface ComputeProviderUsageSampleSummary {
  activeCpuDurationMs: number | null;
  observedMemoryMibMilliseconds: number | null;
  peakMemoryUsageBytes: number | null;
  sampleCount: number;
  lastSampledAt: Date | null;
}

export async function recordComputeProviderUsageSample(
  input: RecordComputeProviderUsageSampleInput,
): Promise<void> {
  await db
    .insert(computeProviderUsageSamples)
    .values({
      provider: input.provider,
      providerUsageId: input.providerUsageId,
      runId: input.runId,
      taskId: input.taskId,
      instanceId: input.instanceId,
      sampledAt: input.sampledAt,
      cpuUsageNsTotal: clampOptionalInteger(input.cpuUsageNsTotal),
      memoryUsageBytes: clampOptionalInteger(input.memoryUsageBytes),
      memoryPeakUsageBytes: clampOptionalInteger(input.memoryPeakUsageBytes),
      details: input.details ?? {},
    })
    .onConflictDoNothing();
}

export async function summarizeComputeProviderUsageSamples(input: {
  provider: ComputeProvider;
  providerUsageId: string;
  startedAt: Date;
  completedAt: Date;
  backfillInitialSample?: boolean;
}): Promise<ComputeProviderUsageSampleSummary> {
  const rows = await db
    .select({
      sampledAt: computeProviderUsageSamples.sampledAt,
      cpuUsageNsTotal: computeProviderUsageSamples.cpuUsageNsTotal,
      memoryUsageBytes: computeProviderUsageSamples.memoryUsageBytes,
      memoryPeakUsageBytes: computeProviderUsageSamples.memoryPeakUsageBytes,
    })
    .from(computeProviderUsageSamples)
    .where(
      and(
        eq(computeProviderUsageSamples.provider, input.provider),
        eq(computeProviderUsageSamples.providerUsageId, input.providerUsageId),
      ),
    )
    .orderBy(asc(computeProviderUsageSamples.sampledAt));

  if (rows.length === 0) {
    return {
      activeCpuDurationMs: null,
      observedMemoryMibMilliseconds: null,
      peakMemoryUsageBytes: null,
      sampleCount: 0,
      lastSampledAt: null,
    };
  }

  let maxCpuUsageNsTotal = 0;
  let peakMemoryUsageBytes = 0;
  let observedMemoryMibMilliseconds = 0;
  let previousAt = input.startedAt;
  let previousMemoryUsageMiB: number | null = null;
  const backfillInitialSample = input.backfillInitialSample ?? true;

  for (const row of rows) {
    const cpuUsageNsTotal = clampOptionalInteger(row.cpuUsageNsTotal);
    const memoryUsageBytes = clampOptionalInteger(row.memoryUsageBytes);

    const memoryPeakUsageBytesForRow = clampOptionalInteger(
      row.memoryPeakUsageBytes,
    );

    if (cpuUsageNsTotal !== null) {
      maxCpuUsageNsTotal = Math.max(maxCpuUsageNsTotal, cpuUsageNsTotal);
    }

    if (memoryPeakUsageBytesForRow !== null) {
      peakMemoryUsageBytes = Math.max(
        peakMemoryUsageBytes,
        memoryPeakUsageBytesForRow,
      );
    } else if (memoryUsageBytes !== null) {
      peakMemoryUsageBytes = Math.max(peakMemoryUsageBytes, memoryUsageBytes);
    }

    if (memoryUsageBytes !== null) {
      const currentMemoryUsageMiB = memoryUsageBytes / BYTES_PER_MIB;

      if (previousMemoryUsageMiB === null && !backfillInitialSample) {
        previousMemoryUsageMiB = currentMemoryUsageMiB;
        previousAt = row.sampledAt;
        continue;
      }

      const intervalMs = Math.max(
        0,
        row.sampledAt.getTime() - previousAt.getTime(),
      );

      const intervalMemoryUsageMiB =
        previousMemoryUsageMiB === null
          ? currentMemoryUsageMiB
          : (previousMemoryUsageMiB + currentMemoryUsageMiB) / 2;

      observedMemoryMibMilliseconds += intervalMemoryUsageMiB * intervalMs;
      previousMemoryUsageMiB = currentMemoryUsageMiB;
      previousAt = row.sampledAt;
    }
  }

  if (previousMemoryUsageMiB !== null) {
    const trailingIntervalMs = Math.max(
      0,
      input.completedAt.getTime() - previousAt.getTime(),
    );

    observedMemoryMibMilliseconds +=
      previousMemoryUsageMiB * trailingIntervalMs;
  }

  return {
    activeCpuDurationMs:
      maxCpuUsageNsTotal > 0
        ? Math.trunc(maxCpuUsageNsTotal / NS_PER_MS)
        : null,
    observedMemoryMibMilliseconds:
      observedMemoryMibMilliseconds > 0
        ? Math.round(observedMemoryMibMilliseconds)
        : null,
    peakMemoryUsageBytes:
      peakMemoryUsageBytes > 0 ? peakMemoryUsageBytes : null,
    sampleCount: rows.length,
    lastSampledAt: rows.at(-1)?.sampledAt ?? null,
  };
}
