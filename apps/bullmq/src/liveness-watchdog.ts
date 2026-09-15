import type { Worker } from 'bullmq';

/**
 * How long the scheduler worker may go without finishing a job before the
 * process is considered hung. The scheduler runs several jobs every minute
 * (heartbeat, sleep check, custom automations), so five quiet minutes with
 * a ready Redis connection means the job loop itself has stopped.
 */
export const BULLMQ_WATCHDOG_STALE_MS = 5 * 60 * 1000;
const BULLMQ_WATCHDOG_INTERVAL_MS = 60 * 1000;

type WatchedWorker = Pick<Worker, 'on' | 'off'>;

/**
 * Exits the process when the scheduler worker stops making progress while
 * Redis still reports ready. A process that is alive but no longer draining
 * its queues looks healthy to the container platform (no crash), to the
 * Redis client (connected), and to `/admin/health` (job counts readable), so
 * nothing restarts it. Exiting with a failure code hands recovery to the
 * platform's on-failure restart policy instead of waiting for a human.
 *
 * Progress is any job the worker finishes, successfully or not. A Redis
 * connection that is not ready is excluded: the worker cannot make progress
 * without it, and the client's own reconnect handles that case.
 */
export function startBullMqLivenessWatchdog(input: {
  worker: WatchedWorker;
  redisStatus: () => string;
  staleMs?: number;
  intervalMs?: number;
  now?: () => number;
  exitProcess?: (code: number) => void;
  onStale?: (details: { idleMs: number; staleMs: number }) => void;
  logError?: (...args: Parameters<typeof console.error>) => void;
}): { stop: () => void } {
  const now = input.now ?? Date.now;
  const staleMs = input.staleMs ?? BULLMQ_WATCHDOG_STALE_MS;
  const intervalMs = input.intervalMs ?? BULLMQ_WATCHDOG_INTERVAL_MS;
  const exitProcess =
    input.exitProcess ?? ((code: number) => process.exit(code));
  const logError = input.logError ?? ((...args) => console.error(...args));

  let lastProgressAt = now();
  const recordProgress = () => {
    lastProgressAt = now();
  };
  input.worker.on('completed', recordProgress);
  input.worker.on('failed', recordProgress);

  const timer = setInterval(() => {
    if (input.redisStatus() !== 'ready') {
      return;
    }
    const idleMs = now() - lastProgressAt;
    if (idleMs <= staleMs) {
      return;
    }
    logError(
      `[liveness-watchdog] scheduler worker finished no job for ${Math.round(idleMs / 1000)}s while Redis is ready; exiting so the platform restarts this process`,
    );
    input.onStale?.({ idleMs, staleMs });
    clearInterval(timer);
    exitProcess(1);
  }, intervalMs);
  timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
      input.worker.off('completed', recordProgress);
      input.worker.off('failed', recordProgress);
    },
  };
}
