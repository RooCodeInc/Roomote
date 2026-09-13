import {
  drainAndAbortFastAgentTurns,
  FastAgentProcessShutdownError,
  resolveFastAgentShutdownDrainMs,
  type FastAgentShutdownDrainDeps,
} from '@roomote/cloud-agents/server';

export function resolveWebShutdownDrainMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return resolveFastAgentShutdownDrainMs(
    ['R_WEB_SHUTDOWN_DRAIN_MS', 'R_API_SHUTDOWN_DRAIN_MS'],
    env as NodeJS.ProcessEnv,
  );
}

type WebShutdownOptions = FastAgentShutdownDrainDeps & {
  drainMs?: number;
};

export async function gracefullyShutdownWeb(
  signal: NodeJS.Signals,
  {
    abortTurns,
    beginDrain,
    waitForTurns,
    drainMs = resolveWebShutdownDrainMs(),
  }: WebShutdownOptions = {},
): Promise<void> {
  await drainAndAbortFastAgentTurns(
    {
      reason: new FastAgentProcessShutdownError(signal),
      drainMs,
      service: 'web',
    },
    { abortTurns, beginDrain, waitForTurns },
  );
}

export function installWebFastAgentGracefulShutdown(
  options: WebShutdownOptions = {},
): () => void {
  let shuttingDown = false;
  const handlers = new Map<NodeJS.Signals, () => void>();

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    const handler = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      void gracefullyShutdownWeb(signal, options);
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
