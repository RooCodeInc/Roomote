import { WORKER_HEARTBEAT_INTERVAL_MS } from '@roomote/types';
import { sdk } from '@roomote/sdk/client';
import { captureWorkerMessage } from '../../monitoring/sentry';

const HEARTBEAT_SENTRY_THRESHOLD = 3;
export const WORKER_HEARTBEAT_RPC_TIMEOUT_MS =
  WORKER_HEARTBEAT_INTERVAL_MS - 5_000;

interface HeartbeatConfig {
  runId: number;
  taskId?: string | null;
  logger: Pick<Console, 'warn'>;
}

function createHeartbeatTimeoutError(runId: number): Error {
  return new Error(
    `Heartbeat RPC timed out after ${WORKER_HEARTBEAT_RPC_TIMEOUT_MS}ms for task run ${runId}`,
  );
}

function getHeartbeatError(
  controller: AbortController,
  runId: number,
  error: unknown,
): unknown {
  if (!controller.signal.aborted) {
    return error;
  }

  if (controller.signal.reason instanceof Error) {
    return controller.signal.reason;
  }

  return createHeartbeatTimeoutError(runId);
}

async function sendHeartbeat({
  runId,
  taskId,
  consecutiveFailureCountRef,
  hasReportedFailureStreakRef,
  logger,
}: HeartbeatConfig & {
  consecutiveFailureCountRef: { current: number };
  hasReportedFailureStreakRef: { current: boolean };
}): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(createHeartbeatTimeoutError(runId));
  }, WORKER_HEARTBEAT_RPC_TIMEOUT_MS);

  try {
    await sdk.taskRuns.touchTaskRunHeartbeat(
      { id: runId },
      { signal: controller.signal },
    );
    consecutiveFailureCountRef.current = 0;
    hasReportedFailureStreakRef.current = false;
  } catch (error) {
    const heartbeatError = getHeartbeatError(controller, runId, error);
    consecutiveFailureCountRef.current += 1;
    logger.warn(
      `[workerHeartbeat] Failed to update heartbeat for task run ${runId}: ${
        heartbeatError instanceof Error
          ? heartbeatError.message
          : String(heartbeatError)
      }`,
    );

    if (
      consecutiveFailureCountRef.current >= HEARTBEAT_SENTRY_THRESHOLD &&
      !hasReportedFailureStreakRef.current
    ) {
      hasReportedFailureStreakRef.current = true;
      captureWorkerMessage(
        'Worker heartbeat updates are repeatedly failing',
        {
          runId,
          taskId,
          stage: 'worker-heartbeat',
          heartbeatIntervalMs: WORKER_HEARTBEAT_INTERVAL_MS,
          consecutiveFailureCount: consecutiveFailureCountRef.current,
          error:
            heartbeatError instanceof Error
              ? heartbeatError.message
              : String(heartbeatError),
        },
        {
          component: 'worker-heartbeat',
          level: 'warning',
          signal: 'worker-heartbeat-failures',
        },
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

export function createWorkerHeartbeatInterval({
  runId,
  taskId,
  logger,
}: HeartbeatConfig): NodeJS.Timeout {
  const consecutiveFailureCountRef = { current: 0 };
  const hasReportedFailureStreakRef = { current: false };
  const heartbeatInFlightRef = { current: false };

  const triggerHeartbeat = () => {
    if (heartbeatInFlightRef.current) {
      return;
    }

    heartbeatInFlightRef.current = true;
    void sendHeartbeat({
      runId,
      taskId,
      consecutiveFailureCountRef,
      hasReportedFailureStreakRef,
      logger,
    }).finally(() => {
      heartbeatInFlightRef.current = false;
    });
  };

  triggerHeartbeat();

  return setInterval(triggerHeartbeat, WORKER_HEARTBEAT_INTERVAL_MS);
}
