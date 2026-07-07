import { WORKER_HEARTBEAT_INTERVAL_MS } from '@roomote/types';
import { sdk } from '@roomote/sdk/client';
import { captureWorkerMessage } from '../../monitoring/sentry';

const HEARTBEAT_SENTRY_THRESHOLD = 3;
export const WORKER_HEARTBEAT_RPC_TIMEOUT_MS =
  WORKER_HEARTBEAT_INTERVAL_MS - 5_000;

interface HeartbeatConfig {
  cloudJobId: number;
  taskId?: string | null;
  logger: Pick<Console, 'warn'>;
}

function createHeartbeatTimeoutError(cloudJobId: number): Error {
  return new Error(
    `Heartbeat RPC timed out after ${WORKER_HEARTBEAT_RPC_TIMEOUT_MS}ms for cloud job ${cloudJobId}`,
  );
}

function getHeartbeatError(
  controller: AbortController,
  cloudJobId: number,
  error: unknown,
): unknown {
  if (!controller.signal.aborted) {
    return error;
  }

  if (controller.signal.reason instanceof Error) {
    return controller.signal.reason;
  }

  return createHeartbeatTimeoutError(cloudJobId);
}

async function sendHeartbeat({
  cloudJobId,
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
    controller.abort(createHeartbeatTimeoutError(cloudJobId));
  }, WORKER_HEARTBEAT_RPC_TIMEOUT_MS);

  try {
    await sdk.cloudJobs.touchCloudJobHeartbeat(
      { id: cloudJobId },
      { signal: controller.signal },
    );
    consecutiveFailureCountRef.current = 0;
    hasReportedFailureStreakRef.current = false;
  } catch (error) {
    const heartbeatError = getHeartbeatError(controller, cloudJobId, error);
    consecutiveFailureCountRef.current += 1;
    logger.warn(
      `[workerHeartbeat] Failed to update heartbeat for cloud job ${cloudJobId}: ${
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
          cloudJobId,
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
  cloudJobId,
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
      cloudJobId,
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
