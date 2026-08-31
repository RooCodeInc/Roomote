import type { ServerType } from '@hono/node-server';
import {
  abortActiveFastAgentTurns,
  FastAgentProcessShutdownError,
} from '@roomote/cloud-agents/server';

type ApiShutdownOptions = {
  abortTurns?: typeof abortActiveFastAgentTurns;
  exitProcess?: (code?: number) => never;
  flushSentry?: () => Promise<unknown>;
  logError?: (...args: Parameters<typeof console.error>) => void;
};

export async function gracefullyShutdownApi(
  server: ServerType,
  signal: NodeJS.Signals,
  {
    abortTurns = abortActiveFastAgentTurns,
    exitProcess = process.exit,
    flushSentry = async () => undefined,
    logError = (...args) => console.error(...args),
  }: ApiShutdownOptions = {},
): Promise<void> {
  const abortPromise = abortTurns(new FastAgentProcessShutdownError(signal));
  const closeError = await new Promise<Error | null>((resolve) => {
    server.close((error) => resolve(error ?? null));
  });
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
