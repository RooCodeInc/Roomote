import type { ServerType } from '@hono/node-server';
import {
  abortActiveFastAgentTurns,
  beginFastAgentTurnDrain,
  FastAgentProcessShutdownError,
  markActiveFastAgentTurnsShutdown,
  waitForActiveFastAgentTurnsToSettle,
} from '@roomote/cloud-agents/server';

// Most Fast turns finish within seconds, so letting them settle turns a
// deploy-time interruption into a completed answer. The default leaves room
// for the straggler abort, closeout delivery, and Sentry flush inside a
// typical 30s SIGTERM-to-SIGKILL grace window. R_API_SHUTDOWN_DRAIN_MS
// overrides it; 0 restores the previous abort-immediately behavior.
const DEFAULT_API_SHUTDOWN_DRAIN_MS = 20_000;
// How long a still-pending shutdown stamp may hold the exit after the drain
// and the abort have already given it time.
const STAMP_SETTLE_GRACE_MS = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

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
  markTurnsShutdown?: typeof markActiveFastAgentTurnsShutdown;
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
    markTurnsShutdown = markActiveFastAgentTurnsShutdown,
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
  // The platform may SIGKILL right after SIGTERM (Railway's default grace is
  // zero), so the evidence that these turns were cut short is written now,
  // alongside the drain rather than after it. A turn that finishes during
  // the drain settles its row and the stamp is moot.
  const markPromise = markTurnsShutdown({
    lockTtlSeconds: Math.ceil(drainMs / 1000) + 60,
  }).catch(() => 0);
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
  // The stamps have had the drain and the abort to land. Give a slow one a
  // last brief moment, but never let it hold up the exit: losing a stamp
  // costs latency (the reconciler falls back to the lease), holding the
  // process costs the platform's patience.
  await Promise.race([markPromise, delay(STAMP_SETTLE_GRACE_MS)]);
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
