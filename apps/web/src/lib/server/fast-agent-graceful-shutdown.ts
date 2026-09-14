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

const WEB_FAST_AGENT_SHUTDOWN_HANDLER = Symbol.for(
  'roomote.web-fast-agent-shutdown-handler',
);

type ShutdownGlobal = typeof globalThis & {
  [WEB_FAST_AGENT_SHUTDOWN_HANDLER]?: (signal: NodeJS.Signals) => Promise<void>;
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
  const scope = globalThis as ShutdownGlobal;
  const handler = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await gracefullyShutdownWeb(signal, options);
    options.notifyReady?.(signal);
  };
  scope[WEB_FAST_AGENT_SHUTDOWN_HANDLER] = handler;

  return () => {
    if (scope[WEB_FAST_AGENT_SHUTDOWN_HANDLER] === handler) {
      delete scope[WEB_FAST_AGENT_SHUTDOWN_HANDLER];
    }
  };
}
