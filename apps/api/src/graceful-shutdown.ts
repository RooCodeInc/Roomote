import type { ServerType } from '@hono/node-server';
import {
  abortActiveFastAgentTurns,
  beginFastAgentTurnDrain,
  FastAgentProcessShutdownError,
  waitForActiveFastAgentTurnsToSettle,
} from '@roomote/cloud-agents/server';

// Most Fast turns finish within seconds, so letting them settle turns a
// deploy-time interruption into a completed answer. The default leaves room
// for the straggler abort, closeout delivery, and Sentry flush inside a
// typical 30s SIGTERM-to-SIGKILL grace window. R_API_SHUTDOWN_DRAIN_MS
// overrides it; 0 restores the previous abort-immediately behavior.
const DEFAULT_API_SHUTDOWN_DRAIN_MS = 20_000;

export function resolveApiShutdownDrainMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.R_API_SHUTDOWN_DRAIN_MS?.trim();
  if (!raw) return DEFAULT_API_SHUTDOWN_DRAIN_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_API_SHUTDOWN_DRAIN_MS;
}

type ApiShutdownOptions = {
  abortTurns?: typeof abortActiveFastAgentTurns;
  beginDrain?: typeof beginFastAgentTurnDrain;
  waitForTurns?: typeof waitForActiveFastAgentTurnsToSettle;
  drainMs?: number;
  exitProcess?: (code?: number) => never;
  flushSentry?: () => Promise<unknown>;
  logError?: (...args: Parameters<typeof console.error>) => void;
  logWarn?: (...args: Parameters<typeof console.warn>) => void;
};

export async function gracefullyShutdownApi(
  server: ServerType,
  signal: NodeJS.Signals,
  {
    abortTurns = abortActiveFastAgentTurns,
    beginDrain = beginFastAgentTurnDrain,
    waitForTurns = waitForActiveFastAgentTurnsToSettle,
    drainMs = resolveApiShutdownDrainMs(),
    exitProcess = process.exit,
    flushSentry = async () => undefined,
    logError = (...args) => console.error(...args),
    logWarn = (...args) => console.warn(...args),
  }: ApiShutdownOptions = {},
): Promise<void> {
  const reason = new FastAgentProcessShutdownError(signal);
  // Refuse new turn admissions and stop accepting connections first, then
  // give in-flight turns a bounded window to finish on their own. Only the
  // stragglers still active at the deadline are aborted.
  beginDrain(reason);
  const closePromise = new Promise<Error | null>((resolve) => {
    server.close((error) => resolve(error ?? null));
  });
  const remaining = await waitForTurns(drainMs);
  if (remaining > 0) {
    logWarn(
      `[api] Aborting ${remaining} Fast turn(s) still active after the ${drainMs}ms shutdown drain.`,
    );
  }
  const abortPromise = abortTurns(reason);
  const closeError = await closePromise;
  await abortPromise;
  if (closeError) {
    logError('[api] Graceful shutdown failed', closeError);
  }
  await flushSentry();
  exitProcess(closeError ? 1 : 0);
}

export function installApiGracefulShutdown(
  server: ServerType,
  options: ApiShutdownOptions = {},
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
      void gracefullyShutdownApi(server, signal, options);
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
