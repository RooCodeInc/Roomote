import { WORKER_HEARTBEAT_INTERVAL_MS } from '@roomote/types';
import { sdk } from '@roomote/sdk/client';
import { captureWorkerMessage } from '../../monitoring/sentry';

const HEARTBEAT_SENTRY_THRESHOLD = 3;

/**
 * Server message (run-token guard) returned when the persisted run is in a
 * terminal status. The control plane finalizes standby/swept runs while
 * their workers may still be alive — a suspended-then-woken worker resumes
 * with a dead token and must terminate itself instead of idling forever as
 * a zombie (holding the sandbox-server port and killing its successor's
 * boot). This is authoritative server-side truth, not a transient failure.
 */
const RUN_TERMINAL_HEARTBEAT_MESSAGE =
  'Cannot access resources from a different run';

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

    if (
      heartbeatError instanceof Error &&
      heartbeatError.message.includes(RUN_TERMINAL_HEARTBEAT_MESSAGE)
    ) {
      logger.warn(
        `[workerHeartbeat] Task run ${runId} is finalized server-side; terminating this worker.`,
      );
      // The run this worker belongs to no longer exists as an active run —
      // every control-plane call will fail the same way, so graceful
      // teardown has nothing useful left to do. Exit promptly so the
      // sandbox is free for its next wake.
      process.exit(0);
    }

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
