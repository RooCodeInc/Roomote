import type { RunEventDetails, RunEventType } from '@roomote/types';
import { sdk } from '@roomote/sdk/client';

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toIso(value: number | undefined): string | null {
  return value == null ? null : new Date(value).toISOString();
}

export function buildWorkerRuntimeStateDetails(input: {
  taskPhase: string | null;
  sleepAt: number | null;
  reason: string;
  keepaliveMs?: number;
  sandboxTimeoutMs?: number;
  sandboxExpiresAtMs?: number;
  isConnected?: boolean;
  runtimeTaskId?: string;
  cancelTriggeredAt?: number;
  lastMessageAt?: number;
  taskFinishedAt?: number;
  taskAbortedAt?: number;
  clientDisconnectedAt?: number;
  lastErrorMessage?: string;
}) {
  return {
    reason: input.reason,
    taskPhase: input.taskPhase,
    sleepAt:
      input.sleepAt == null ? null : new Date(input.sleepAt).toISOString(),
    keepaliveMs: input.keepaliveMs ?? null,
    sandboxTimeoutMs: input.sandboxTimeoutMs ?? null,
    sandboxExpiresAt:
      input.sandboxExpiresAtMs == null
        ? null
        : new Date(input.sandboxExpiresAtMs).toISOString(),
    isConnected: input.isConnected ?? null,
    runtimeTaskId: input.runtimeTaskId ?? null,
    cancelTriggeredAt: toIso(input.cancelTriggeredAt),
    lastMessageAt: toIso(input.lastMessageAt),
    taskFinishedAt: toIso(input.taskFinishedAt),
    taskAbortedAt: toIso(input.taskAbortedAt),
    clientDisconnectedAt: toIso(input.clientDisconnectedAt),
    lastErrorMessage: input.lastErrorMessage ?? null,
  };
}

export function buildWorkerTaskEventDetails(input: {
  eventName: string;
  taskPhase: string | null;
  isConnected?: boolean;
  runtimeTaskId?: string;
}) {
  return {
    taskStateEvent: input.eventName,
    taskPhase: input.taskPhase,
    isConnected: input.isConnected ?? null,
    runtimeTaskId: input.runtimeTaskId ?? null,
  };
}

export function createWorkerRuntimeEventRecorder(options: {
  cloudJobId: number;
  logger: Pick<Console, 'warn'>;
}) {
  return async (input: {
    eventType: RunEventType;
    message: string;
    details?: RunEventDetails;
  }): Promise<void> => {
    try {
      await sdk.cloudJobs.recordEvent({
        cloudJobId: options.cloudJobId,
        source: 'worker_runtime',
        eventType: input.eventType,
        message: input.message,
        details: input.details,
      });
    } catch (error) {
      options.logger.warn(
        `[workerRuntimeEvents] Failed to persist event for cloud job ${options.cloudJobId}: ${formatError(error)}`,
      );
    }
  };
}
