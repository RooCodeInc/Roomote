import {
  drainAndAbortFastAgentTurns,
  FastAgentProcessShutdownError,
  resolveFastAgentShutdownDrainMs,
  type FastAgentShutdownDrainDeps,
} from '@roomote/cloud-agents/server';

/**
 * Once the stragglers are aborted, each resumed turn's job rejects and the
 * Fast worker's close resolves. A turn that ignores its abort would hold the
 * close open; SIGKILL is coming anyway, so the wait is bounded.
 */
const DEFAULT_FAST_AGENT_WORKER_CLOSE_TIMEOUT_MS = 5_000;

/**
 * `R_BULLMQ_SHUTDOWN_DRAIN_MS` sizes the window for the turns this process
 * resumes; it falls back to the API's window so one setting covers both.
 */
export function resolveBullMqShutdownDrainMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return resolveFastAgentShutdownDrainMs(
    ['R_BULLMQ_SHUTDOWN_DRAIN_MS', 'R_API_SHUTDOWN_DRAIN_MS'],
    env,
  );
}

type Closeable = { close: () => Promise<void> };

type BullMqShutdownOptions = FastAgentShutdownDrainDeps & {
  /**
   * The worker that executes resumed Fast turns. Closed as the drain starts
   * so it stops fetching new wakeups; its active jobs are the turns the
   * drain waits for.
   */
  fastAgentWorker: Closeable;
  /** Every other queue, worker, and connection; closed once the Fast turns
   * have finished or been handed back. */
  closeRemaining: () => Promise<void>;
  drainMs?: number;
  workerCloseTimeoutMs?: number;
  exitProcess?: (code?: number) => never;
  logError?: (...args: Parameters<typeof console.error>) => void;
  logWarn?: (...args: Parameters<typeof console.warn>) => void;
  logInfo?: (...args: Parameters<typeof console.log>) => void;
};

function waitWithTimeout(promise: Promise<void>, timeoutMs: number) {
  return new Promise<'closed' | 'timeout'>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref();
    void promise.then(() => {
      clearTimeout(timer);
      resolve('closed');
    });
  });
}

/**
 * Resumed Fast turns run inside this process, so it owes them the same
 * hand-off the API gives the turns it admits: close admissions, let in-flight
 * turns finish inside the drain window, abort the stragglers so each releases
 * its durable claim and wakes the queue, and only then close everything else.
 * Without this the turn dies with SIGKILL holding its claim and the
 * conversation lock, and the row waits out both leases before it resumes.
 */
export async function gracefullyShutdownBullMq(
  signal: NodeJS.Signals,
  {
    abortTurns,
    beginDrain,
    waitForTurns,
    fastAgentWorker,
    closeRemaining,
    drainMs = resolveBullMqShutdownDrainMs(),
    workerCloseTimeoutMs = DEFAULT_FAST_AGENT_WORKER_CLOSE_TIMEOUT_MS,
    exitProcess = process.exit,
    logError = (...args) => console.error(...args),
    logWarn = (...args) => console.warn(...args),
    logInfo = (...args) => console.log(...args),
  }: BullMqShutdownOptions,
): Promise<void> {
  logInfo('[Shutdown] Starting graceful shutdown...');
  const reason = new FastAgentProcessShutdownError(signal);
  let workerClosed: Promise<void> = Promise.resolve();
  await drainAndAbortFastAgentTurns(
    {
      reason,
      drainMs,
      service: 'bullmq',
      logWarn,
      onDrainStarted: () => {
        workerClosed = fastAgentWorker.close().catch((error) => {
          logError(
            '[bullmq] Failed to close the Fast parent event worker',
            error,
          );
        });
      },
    },
    { abortTurns, beginDrain, waitForTurns },
  );
  if (
    (await waitWithTimeout(workerClosed, workerCloseTimeoutMs)) === 'timeout'
  ) {
    logWarn(
      `[bullmq] Fast parent event worker did not close within ${workerCloseTimeoutMs}ms of the abort; continuing shutdown.`,
    );
  }
  try {
    await closeRemaining();
  } catch (error) {
    logError('[Shutdown] Error during shutdown:', error);
  }
  exitProcess(0);
}

export function installBullMqGracefulShutdown(
  options: BullMqShutdownOptions,
): () => void {
  let shuttingDown = false;
  const handlers = new Map<NodeJS.Signals, () => void>();

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    const handler = () => {
      if (shuttingDown) {
        (options.exitProcess ?? process.exit)(1);
        return;
      }
      shuttingDown = true;
      void gracefullyShutdownBullMq(signal, options);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  return () => {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
  };
}
