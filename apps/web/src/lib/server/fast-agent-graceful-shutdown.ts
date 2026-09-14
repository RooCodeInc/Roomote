import {
  drainAndAbortFastAgentTurns,
  FastAgentProcessShutdownError,
  resolveFastAgentShutdownDrainMs,
  type FastAgentShutdownDrainDeps,
} from '@roomote/cloud-agents/server';

/** `R_WEB_SHUTDOWN_DRAIN_MS` overrides the API window, which overrides the
 * shared default; 0 aborts at once. */
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
  logError?: (...args: Parameters<typeof console.error>) => void;
  logWarn?: (...args: Parameters<typeof console.warn>) => void;
};

/**
 * Hand off the Fast turns this web process runs before it exits. Next's own
 * signal handler closes the HTTP server and then awaits every pending
 * `after()` task before it calls `process.exit`, and each web Fast turn runs
 * inside `after()`. Closing admissions and aborting the stragglers makes those
 * tasks settle with their durable claim released and the conversation lock
 * deleted, so Next exits promptly and the successor process resumes the turn
 * instead of waiting out the 10-minute lock and 15-minute claim leases. This
 * listener never exits the process itself; that stays with Next.
 */
export async function gracefullyShutdownWebFastAgentTurns(
  signal: NodeJS.Signals,
  {
    abortTurns,
    beginDrain,
    waitForTurns,
    drainMs = resolveWebShutdownDrainMs(),
    logWarn = (...args) => console.warn(...args),
  }: WebShutdownOptions = {},
): Promise<number> {
  return drainAndAbortFastAgentTurns(
    {
      reason: new FastAgentProcessShutdownError(signal),
      drainMs,
      service: 'web',
      logWarn,
    },
    { abortTurns, beginDrain, waitForTurns },
  );
}

const INSTALLED_UNINSTALL = Symbol.for('roomote.web-fast-agent-shutdown');

type ShutdownScope = typeof globalThis & {
  [INSTALLED_UNINSTALL]?: () => void;
};

/**
 * Install the SIGTERM/SIGINT hand-off once per process. Must be called from
 * the same module graph that runs the turns: the standalone build bundles
 * workspace packages per entry, so a listener registered from a different
 * bundle (for example `instrumentation.ts`) would see an empty lock registry
 * and a foreign `FastAgentProcessShutdownError` class. Repeated calls (dev
 * module re-evaluation) return the existing uninstall.
 */
export function installWebFastAgentGracefulShutdown(
  options: WebShutdownOptions = {},
): () => void {
  const scope = globalThis as ShutdownScope;
  const existing = scope[INSTALLED_UNINSTALL];
  if (existing) return existing;

  let shuttingDown = false;
  const handlers = new Map<NodeJS.Signals, () => void>();
  const logError = options.logError ?? ((...args) => console.error(...args));

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    const handler = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      void gracefullyShutdownWebFastAgentTurns(signal, options).catch(
        (error) => {
          logError('[web] Fast turn shutdown hand-off failed', error);
        },
      );
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  const uninstall = () => {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
    if (scope[INSTALLED_UNINSTALL] === uninstall) {
      delete scope[INSTALLED_UNINSTALL];
    }
  };
  scope[INSTALLED_UNINSTALL] = uninstall;
  return uninstall;
}
