import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import {
  type ComputeProvider,
  WORKER_HEARTBEAT_INTERVAL_MS,
} from '@roomote/types';
import { sdk } from '@roomote/sdk/client';

const CGROUP_CPU_USAGE_PATH_V1 = '/sys/fs/cgroup/cpuacct/cpuacct.usage';

const CGROUP_CPU_STAT_PATH_V2 = '/sys/fs/cgroup/cpu.stat';

const CGROUP_MEMORY_USAGE_PATH_V1 =
  '/sys/fs/cgroup/memory/memory.usage_in_bytes';

const CGROUP_MEMORY_USAGE_PATH_V2 = '/sys/fs/cgroup/memory.current';

const CGROUP_MEMORY_PEAK_USAGE_PATH_V1 =
  '/sys/fs/cgroup/memory/memory.max_usage_in_bytes';

const CGROUP_MEMORY_PEAK_USAGE_PATH_V2 = '/sys/fs/cgroup/memory.peak';

const BYTES_PER_MIB = 1024 * 1024;

const BYTES_PER_GIB = BYTES_PER_MIB * 1024;

const MODAL_MEMORY_DIAGNOSTIC_ELEVATED_BYTES = 12 * BYTES_PER_GIB;

const MODAL_MEMORY_DIAGNOSTIC_CRITICAL_BYTES = 14 * BYTES_PER_GIB;

const MODAL_MEMORY_DIAGNOSTIC_DELTA_BYTES = BYTES_PER_GIB;

const MODAL_TOP_PROCESS_LIMIT = 5;

const MODAL_PS_TIMEOUT_MS = 2_000;

interface ComputeProviderUsageConfig {
  cloudJobId: number;
  computeProvider: ComputeProvider;
  logger: Pick<Console, 'warn'>;
  recordDiagnosticEvent?: (
    input: ModalMemoryDiagnosticEvent,
  ) => Promise<void> | void;
}

type CgroupCounterSource = 'cgroup_v1' | 'cgroup_v2';

type ModalMemoryPressureBand = 'normal' | 'elevated' | 'critical';

interface CgroupUsageObservation {
  sampledCpuUsageNsTotal?: number;
  sampledMemoryUsageBytes?: number;
  sampledMemoryPeakUsageBytes?: number;
  sampledCpuUsageSource?: CgroupCounterSource;
  sampledMemoryUsageSource?: CgroupCounterSource;
  sampledMemoryPeakUsageSource?: CgroupCounterSource;
}

interface CgroupReaderOptions {
  readFileFn?: typeof readFile;
}

interface CgroupSamplingState {
  hasWarnedAboutMissingCounters: boolean;
  previousMemoryUsageBytes: number | null;
  previousMemoryPressureBand: ModalMemoryPressureBand;
}

interface ComputeProviderUsageLoop {
  stop: () => void;
  flush: (options?: { updateKind?: string }) => Promise<void>;
}

interface SampledCgroupCounterValue {
  value: number | null;
  source: CgroupCounterSource | null;
}

interface ModalDiagnosticTopProcess {
  pid: number | null;
  ppid: number | null;
  rssBytes: number | null;
  command: string;
  args: string | null;
}

interface ModalMemoryDiagnosticSnapshot {
  triggerReasons: string[];
  memoryPressureBand: ModalMemoryPressureBand;
  sampledMemoryUsageBytes: number | null;
  sampledMemoryPeakUsageBytes: number | null;
  memoryDeltaBytes: number | null;
  cgroupSources: {
    cpuUsage: CgroupCounterSource | null;
    memoryUsage: CgroupCounterSource | null;
    memoryPeakUsage: CgroupCounterSource | null;
  };
  nodeProcess: {
    pid: number;
    ppid: number;
    uptimeSeconds: number;
    rssBytes: number;
    heapTotalBytes: number;
    heapUsedBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
    maxRssKib: number;
  };
  topProcesses: ModalDiagnosticTopProcess[];
  processSnapshotError: string | null;
}

interface ModalMemoryDiagnosticEvent {
  message: string;
  details: Record<string, unknown>;
}

async function readNonNegativeIntegerFile(
  path: string,
  readFileFn: typeof readFile = readFile,
): Promise<number | null> {
  try {
    const content = await readFileFn(path, 'utf8');
    const numericValue = Number.parseInt(content.trim(), 10);

    if (!Number.isFinite(numericValue)) {
      return null;
    }

    return Math.max(0, numericValue);
  } catch {
    return null;
  }
}

async function readCpuUsageNanoseconds(
  readFileFn: typeof readFile = readFile,
): Promise<SampledCgroupCounterValue> {
  const v1Usage = await readNonNegativeIntegerFile(
    CGROUP_CPU_USAGE_PATH_V1,
    readFileFn,
  );

  if (v1Usage !== null) {
    return { value: v1Usage, source: 'cgroup_v1' };
  }

  try {
    const cpuStat = await readFileFn(CGROUP_CPU_STAT_PATH_V2, 'utf8');
    const usageMatch = cpuStat.match(/^usage_usec\s+(\d+)$/m);

    if (!usageMatch) {
      return { value: null, source: null };
    }

    const usageMicroseconds = Number.parseInt(usageMatch[1] ?? '', 10);

    if (!Number.isFinite(usageMicroseconds)) {
      return { value: null, source: null };
    }

    return {
      value: Math.max(0, usageMicroseconds) * 1_000,
      source: 'cgroup_v2',
    };
  } catch {
    return { value: null, source: null };
  }
}

async function readModalCounterValue(input: {
  v1Path: string;
  v2Path: string;
  readFileFn: typeof readFile;
}): Promise<SampledCgroupCounterValue> {
  const v1Value = await readNonNegativeIntegerFile(
    input.v1Path,
    input.readFileFn,
  );

  if (v1Value !== null) {
    return { value: v1Value, source: 'cgroup_v1' };
  }

  const v2Value = await readNonNegativeIntegerFile(
    input.v2Path,
    input.readFileFn,
  );

  if (v2Value !== null) {
    return { value: v2Value, source: 'cgroup_v2' };
  }

  return { value: null, source: null };
}

function formatProcessSnapshotError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toRoundedMib(value: number | null | undefined): number | null {
  if (value == null) {
    return null;
  }

  return Math.round((value / BYTES_PER_MIB) * 100) / 100;
}

function getModalMemoryPressureBand(
  memoryUsageBytes: number | null | undefined,
): ModalMemoryPressureBand {
  if (memoryUsageBytes == null) {
    return 'normal';
  }

  if (memoryUsageBytes >= MODAL_MEMORY_DIAGNOSTIC_CRITICAL_BYTES) {
    return 'critical';
  }

  if (memoryUsageBytes >= MODAL_MEMORY_DIAGNOSTIC_ELEVATED_BYTES) {
    return 'elevated';
  }

  return 'normal';
}

function getModalDiagnosticTriggerReasons(input: {
  updateKind: string;
  memoryPressureBand: ModalMemoryPressureBand;
  previousMemoryPressureBand: ModalMemoryPressureBand;
  memoryDeltaBytes: number | null;
}): string[] {
  const reasons: string[] = [];

  if (input.updateKind === 'shutdown_flush') {
    reasons.push('shutdown_flush');
  }

  if (
    input.memoryPressureBand === 'elevated' &&
    input.previousMemoryPressureBand === 'normal'
  ) {
    reasons.push('memory_pressure_elevated');
  }

  if (
    input.memoryPressureBand === 'critical' &&
    input.previousMemoryPressureBand !== 'critical'
  ) {
    reasons.push('memory_pressure_critical');
  }

  if (
    input.memoryDeltaBytes !== null &&
    input.memoryDeltaBytes >= MODAL_MEMORY_DIAGNOSTIC_DELTA_BYTES
  ) {
    reasons.push('memory_jump_1_gib');
  }

  return reasons;
}

async function collectTopRssProcesses(): Promise<{
  topProcesses: ModalDiagnosticTopProcess[];
  processSnapshotError: string | null;
}> {
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        'ps',
        ['-eo', 'pid=,ppid=,rss=,comm=,args=', '--sort=-rss'],
        {
          timeout: MODAL_PS_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        },
        (error, processStdout) => {
          if (error) {
            reject(error);
            return;
          }

          resolve(processStdout);
        },
      );
    });

    const topProcesses = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, MODAL_TOP_PROCESS_LIMIT)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);

        if (!match) {
          return {
            pid: null,
            ppid: null,
            rssBytes: null,
            command: 'unknown',
            args: line.slice(0, 200),
          } satisfies ModalDiagnosticTopProcess;
        }

        const [, pid, ppid, rssKib, command, args] = match;

        return {
          pid: Number.parseInt(pid ?? '', 10),
          ppid: Number.parseInt(ppid ?? '', 10),
          rssBytes: Number.parseInt(rssKib ?? '', 10) * 1024,
          command: command ?? 'unknown',
          args: args ? args.slice(0, 200) : null,
        } satisfies ModalDiagnosticTopProcess;
      });

    return { topProcesses, processSnapshotError: null };
  } catch (error) {
    return {
      topProcesses: [],
      processSnapshotError: formatProcessSnapshotError(error),
    };
  }
}

async function buildModalMemoryDiagnosticSnapshot(input: {
  modalUsageObservation: CgroupUsageObservation;
  triggerReasons: string[];
  memoryPressureBand: ModalMemoryPressureBand;
  memoryDeltaBytes: number | null;
}): Promise<ModalMemoryDiagnosticSnapshot> {
  const { topProcesses, processSnapshotError } = await collectTopRssProcesses();
  const processMemory = process.memoryUsage();
  const resourceUsage = process.resourceUsage();

  return {
    triggerReasons: input.triggerReasons,
    memoryPressureBand: input.memoryPressureBand,
    sampledMemoryUsageBytes:
      input.modalUsageObservation.sampledMemoryUsageBytes ?? null,
    sampledMemoryPeakUsageBytes:
      input.modalUsageObservation.sampledMemoryPeakUsageBytes ?? null,
    memoryDeltaBytes: input.memoryDeltaBytes,
    cgroupSources: {
      cpuUsage: input.modalUsageObservation.sampledCpuUsageSource ?? null,
      memoryUsage: input.modalUsageObservation.sampledMemoryUsageSource ?? null,
      memoryPeakUsage:
        input.modalUsageObservation.sampledMemoryPeakUsageSource ?? null,
    },
    nodeProcess: {
      pid: process.pid,
      ppid: process.ppid,
      uptimeSeconds: Math.round(process.uptime()),
      rssBytes: processMemory.rss,
      heapTotalBytes: processMemory.heapTotal,
      heapUsedBytes: processMemory.heapUsed,
      externalBytes: processMemory.external,
      arrayBuffersBytes: processMemory.arrayBuffers,
      maxRssKib: resourceUsage.maxRSS,
    },
    topProcesses,
    processSnapshotError,
  };
}

function buildModalMemoryDiagnosticEvent(input: {
  cloudJobId: number;
  updateKind: string;
  memoryDiagnosticSnapshot: ModalMemoryDiagnosticSnapshot;
}): ModalMemoryDiagnosticEvent {
  const { memoryDiagnosticSnapshot } = input;

  return {
    message: `Captured Modal memory diagnostic snapshot for cloud job #${input.cloudJobId}.`,
    details: {
      reason: 'modal_memory_pressure_diagnostic',
      updateKind: input.updateKind,
      diagnosticTriggerReasons: memoryDiagnosticSnapshot.triggerReasons,
      memoryPressureBand: memoryDiagnosticSnapshot.memoryPressureBand,
      sampledMemoryUsageBytes: memoryDiagnosticSnapshot.sampledMemoryUsageBytes,
      sampledMemoryUsageMib: toRoundedMib(
        memoryDiagnosticSnapshot.sampledMemoryUsageBytes,
      ),
      sampledMemoryPeakUsageBytes:
        memoryDiagnosticSnapshot.sampledMemoryPeakUsageBytes,
      sampledMemoryPeakUsageMib: toRoundedMib(
        memoryDiagnosticSnapshot.sampledMemoryPeakUsageBytes,
      ),
      memoryDeltaBytes: memoryDiagnosticSnapshot.memoryDeltaBytes,
      memoryDeltaMib: toRoundedMib(memoryDiagnosticSnapshot.memoryDeltaBytes),
      cgroupSources: memoryDiagnosticSnapshot.cgroupSources,
      nodeProcess: {
        ...memoryDiagnosticSnapshot.nodeProcess,
        rssMib: toRoundedMib(memoryDiagnosticSnapshot.nodeProcess.rssBytes),
        heapTotalMib: toRoundedMib(
          memoryDiagnosticSnapshot.nodeProcess.heapTotalBytes,
        ),
        heapUsedMib: toRoundedMib(
          memoryDiagnosticSnapshot.nodeProcess.heapUsedBytes,
        ),
        externalMib: toRoundedMib(
          memoryDiagnosticSnapshot.nodeProcess.externalBytes,
        ),
        arrayBuffersMib: toRoundedMib(
          memoryDiagnosticSnapshot.nodeProcess.arrayBuffersBytes,
        ),
      },
      topProcesses: memoryDiagnosticSnapshot.topProcesses.map(
        (processInfo) => ({
          ...processInfo,
          rssMib: toRoundedMib(processInfo.rssBytes),
        }),
      ),
      processSnapshotError: memoryDiagnosticSnapshot.processSnapshotError,
    },
  };
}

export async function sampleCgroupUsage(
  options: CgroupReaderOptions = {},
): Promise<CgroupUsageObservation | null> {
  const readFileFn = options.readFileFn ?? readFile;

  const [
    sampledCpuUsageNsTotal,
    sampledMemoryUsageBytes,
    sampledMemoryPeakUsageBytes,
  ] = await Promise.all([
    readCpuUsageNanoseconds(readFileFn),
    readModalCounterValue({
      v1Path: CGROUP_MEMORY_USAGE_PATH_V1,
      v2Path: CGROUP_MEMORY_USAGE_PATH_V2,
      readFileFn,
    }),
    readModalCounterValue({
      v1Path: CGROUP_MEMORY_PEAK_USAGE_PATH_V1,
      v2Path: CGROUP_MEMORY_PEAK_USAGE_PATH_V2,
      readFileFn,
    }),
  ]);

  if (
    sampledCpuUsageNsTotal.value === null &&
    sampledMemoryUsageBytes.value === null &&
    sampledMemoryPeakUsageBytes.value === null
  ) {
    return null;
  }

  return {
    ...(sampledCpuUsageNsTotal.value !== null
      ? {
          sampledCpuUsageNsTotal: sampledCpuUsageNsTotal.value,
          sampledCpuUsageSource: sampledCpuUsageNsTotal.source ?? undefined,
        }
      : {}),
    ...(sampledMemoryUsageBytes.value !== null
      ? {
          sampledMemoryUsageBytes: sampledMemoryUsageBytes.value,
          sampledMemoryUsageSource: sampledMemoryUsageBytes.source ?? undefined,
        }
      : {}),
    ...(sampledMemoryPeakUsageBytes.value !== null
      ? {
          sampledMemoryPeakUsageBytes: sampledMemoryPeakUsageBytes.value,
          sampledMemoryPeakUsageSource:
            sampledMemoryPeakUsageBytes.source ?? undefined,
        }
      : {}),
  };
}

async function recordUsageEstimate({
  cloudJobId,
  computeProvider,
  logger,
  recordDiagnosticEvent,
  updateKind = 'periodic',
  cgroupSamplingState,
}: ComputeProviderUsageConfig & {
  updateKind?: string;
  cgroupSamplingState?: CgroupSamplingState;
}): Promise<void> {
  let cgroupUsageObservation: CgroupUsageObservation | null = null;
  let memoryDiagnosticEvent: ModalMemoryDiagnosticEvent | null = null;

  try {
    cgroupUsageObservation = await sampleCgroupUsage();

    if (
      computeProvider === 'modal' &&
      cgroupUsageObservation === null &&
      cgroupSamplingState &&
      !cgroupSamplingState.hasWarnedAboutMissingCounters
    ) {
      cgroupSamplingState.hasWarnedAboutMissingCounters = true;
      logger.warn(
        `[workerComputeUsage] Modal cgroup usage counters unavailable for cloud job ${cloudJobId}; falling back to requested-resource estimates.`,
      );
    }

    if (
      computeProvider === 'modal' &&
      cgroupUsageObservation !== null &&
      cgroupSamplingState
    ) {
      const currentMemoryUsageBytes =
        cgroupUsageObservation.sampledMemoryUsageBytes ?? null;
      const currentMemoryPressureBand = getModalMemoryPressureBand(
        currentMemoryUsageBytes,
      );
      const memoryDeltaBytes =
        currentMemoryUsageBytes !== null &&
        cgroupSamplingState.previousMemoryUsageBytes !== null
          ? currentMemoryUsageBytes -
            cgroupSamplingState.previousMemoryUsageBytes
          : null;

      const diagnosticTriggerReasons = getModalDiagnosticTriggerReasons({
        updateKind,
        memoryPressureBand: currentMemoryPressureBand,
        previousMemoryPressureBand:
          cgroupSamplingState.previousMemoryPressureBand,
        memoryDeltaBytes,
      });

      if (diagnosticTriggerReasons.length > 0) {
        const memoryDiagnosticSnapshot =
          await buildModalMemoryDiagnosticSnapshot({
            modalUsageObservation: cgroupUsageObservation,
            triggerReasons: diagnosticTriggerReasons,
            memoryPressureBand: currentMemoryPressureBand,
            memoryDeltaBytes,
          });

        memoryDiagnosticEvent = buildModalMemoryDiagnosticEvent({
          cloudJobId,
          updateKind,
          memoryDiagnosticSnapshot,
        });
      }

      cgroupSamplingState.previousMemoryUsageBytes = currentMemoryUsageBytes;
      cgroupSamplingState.previousMemoryPressureBand =
        currentMemoryPressureBand;
    }
  } catch (error) {
    logger.warn(
      `[workerComputeUsage] Failed to sample ${computeProvider === 'modal' ? 'Modal' : 'Sandbox'} cgroup usage for cloud job ${cloudJobId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    await sdk.cloudJobs.recordComputeProviderUsage({
      cloudJobId,
      lifecycleAction: 'running',
      completedAt: new Date(),
      ...(cgroupUsageObservation?.sampledCpuUsageNsTotal !== undefined
        ? {
            sampledCpuUsageNsTotal:
              cgroupUsageObservation.sampledCpuUsageNsTotal,
          }
        : {}),
      ...(cgroupUsageObservation?.sampledMemoryUsageBytes !== undefined
        ? {
            sampledMemoryUsageBytes:
              cgroupUsageObservation.sampledMemoryUsageBytes,
          }
        : {}),
      ...(cgroupUsageObservation?.sampledMemoryPeakUsageBytes !== undefined
        ? {
            sampledMemoryPeakUsageBytes:
              cgroupUsageObservation.sampledMemoryPeakUsageBytes,
          }
        : {}),
      details: {
        source: 'worker_heartbeat',
        updateKind,
        ...(cgroupUsageObservation
          ? { cgroupUsageObservationSource: 'cgroup_poll' }
          : {}),
        ...(memoryDiagnosticEvent
          ? { modalMemoryDiagnostic: memoryDiagnosticEvent.details }
          : {}),
      },
    });
  } catch (error) {
    logger.warn(
      `[workerComputeUsage] Failed to update compute usage for cloud job ${cloudJobId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (memoryDiagnosticEvent && recordDiagnosticEvent) {
    try {
      await recordDiagnosticEvent(memoryDiagnosticEvent);
    } catch (error) {
      logger.warn(
        `[workerComputeUsage] Failed to record Modal memory diagnostic event for cloud job ${cloudJobId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

export function createComputeProviderUsageInterval({
  cloudJobId,
  computeProvider,
  logger,
  recordDiagnosticEvent,
}: ComputeProviderUsageConfig): ComputeProviderUsageLoop {
  const cgroupSamplingState: CgroupSamplingState = {
    hasWarnedAboutMissingCounters: false,
    previousMemoryUsageBytes: null,
    previousMemoryPressureBand: 'normal',
  };

  void recordUsageEstimate({
    cloudJobId,
    computeProvider,
    logger,
    recordDiagnosticEvent,
    cgroupSamplingState,
  });

  const interval = setInterval(() => {
    void recordUsageEstimate({
      cloudJobId,
      computeProvider,
      logger,
      recordDiagnosticEvent,
      cgroupSamplingState,
    });
  }, WORKER_HEARTBEAT_INTERVAL_MS);

  return {
    stop: () => {
      clearInterval(interval);
    },
    flush: async (options) => {
      await recordUsageEstimate({
        cloudJobId,
        computeProvider,
        logger,
        recordDiagnosticEvent,
        updateKind: options?.updateKind ?? 'manual',
        cgroupSamplingState,
      });
    },
  };
}
