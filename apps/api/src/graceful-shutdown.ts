import type { ServerType } from '@hono/node-server';
import {
  drainAndAbortFastAgentTurns,
  FastAgentProcessShutdownError,
  resolveFastAgentShutdownDrainMs,
  type FastAgentShutdownDrainDeps,
} from '@roomote/cloud-agents/server';

/** `R_API_SHUTDOWN_DRAIN_MS` overrides the shared default; 0 aborts at once. */
export function resolveApiShutdownDrainMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return resolveFastAgentShutdownDrainMs(['R_API_SHUTDOWN_DRAIN_MS'], env);
}

type ApiShutdownOptions = FastAgentShutdownDrainDeps & {
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
    abortTurns,
    beginDrain,
    waitForTurns,
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
  let closePromise: Promise<Error | null> = Promise.resolve(null);
  await drainAndAbortFastAgentTurns(
    {
      reason,
      drainMs,
      service: 'api',
      logWarn,
      onDrainStarted: () => {
        closePromise = new Promise<Error | null>((resolve) => {
          server.close((error) => resolve(error ?? null));
        });
      },
    },
    { abortTurns, beginDrain, waitForTurns },
  );
  const closeError = await closePromise;
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
