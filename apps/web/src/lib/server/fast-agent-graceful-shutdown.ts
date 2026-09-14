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
  notifyReady?: (signal: NodeJS.Signals) => void;
};

export const WEB_FAST_AGENT_SHUTDOWN_REQUEST =
  'roomote:web-fast-agent-shutdown';
export const WEB_FAST_AGENT_SHUTDOWN_READY =
  'roomote:web-fast-agent-shutdown-ready';

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
  const handler = (message: unknown) => {
    if (
      shuttingDown ||
      !message ||
      typeof message !== 'object' ||
      !('type' in message) ||
      message.type !== WEB_FAST_AGENT_SHUTDOWN_REQUEST ||
      !('signal' in message) ||
      (message.signal !== 'SIGTERM' && message.signal !== 'SIGINT')
    ) {
      return;
    }
    const signal = message.signal;
    shuttingDown = true;
    void gracefullyShutdownWeb(signal, options).then(() => {
      options.notifyReady?.(signal);
    });
  };
  process.on('message', handler);

  return () => {
    process.off('message', handler);
  };
}
