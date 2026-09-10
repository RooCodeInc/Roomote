import {
  abortActiveFastAgentTurns,
  beginFastAgentTurnDrain,
  type FastAgentProcessShutdownError,
  waitForActiveFastAgentTurnsToSettle,
} from './fast-agent-turn-lock';

/**
 * Most Fast turns finish within seconds, so letting them settle turns a
 * deploy-time interruption into a completed answer. The default leaves room
 * for the straggler abort, the durable hand-back, and a Sentry flush inside
 * a typical 30s SIGTERM-to-SIGKILL grace window.
 */
export const DEFAULT_FAST_AGENT_SHUTDOWN_DRAIN_MS = 20_000;

/**
 * Resolve the shutdown drain window from the first of `keys` that is set. A
 * non-numeric or negative value falls back to the default; 0 is the
 * abort-immediately kill switch.
 */
export function resolveFastAgentShutdownDrainMs(
  keys: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): number {
  for (const key of keys) {
    const raw = env[key]?.trim();
    if (!raw) continue;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0
      ? parsed
      : DEFAULT_FAST_AGENT_SHUTDOWN_DRAIN_MS;
  }
  return DEFAULT_FAST_AGENT_SHUTDOWN_DRAIN_MS;
}

export type FastAgentShutdownDrainDeps = {
  beginDrain?: typeof beginFastAgentTurnDrain;
  waitForTurns?: typeof waitForActiveFastAgentTurnsToSettle;
  abortTurns?: typeof abortActiveFastAgentTurns;
};

/**
 * The shutdown sequence for every process that executes Fast turns: the API
 * runs the turns it admits, and the bullmq service runs the turns the queue
 * resumes. Admissions close first, in-flight turns get the window to finish
 * on their own, and only the stragglers are aborted, so each one hands its
 * durable row back to the queue instead of dying with the claim and the
 * conversation lock held. Returns how many turns were aborted.
 */
export async function drainAndAbortFastAgentTurns(
  params: {
    reason: FastAgentProcessShutdownError;
    drainMs: number;
    /** Process name for the straggler log line. */
    service: string;
    /**
     * Runs once admissions are closed, alongside the drain: stop accepting
     * connections or fetching queue jobs so nothing new arrives while the
     * turns already here finish.
     */
    onDrainStarted?: () => void;
    logWarn?: (message: string) => void;
  },
  deps: FastAgentShutdownDrainDeps = {},
): Promise<number> {
  const {
    beginDrain = beginFastAgentTurnDrain,
    waitForTurns = waitForActiveFastAgentTurnsToSettle,
    abortTurns = abortActiveFastAgentTurns,
  } = deps;
  const logWarn =
    params.logWarn ?? ((message: string) => console.warn(message));

  beginDrain(params.reason);
  params.onDrainStarted?.();
  const remaining = await waitForTurns(params.drainMs);
  if (remaining > 0) {
    logWarn(
      `[${params.service}] Aborting ${remaining} Fast turn(s) still active after the ${params.drainMs}ms shutdown drain.`,
    );
  }
  return abortTurns(params.reason);
}
