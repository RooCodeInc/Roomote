import type { StartupLogger } from '../../logging';

export function formatDurationMs(ms: number): string {
  if (ms < 1_000) {
    return `${ms}ms`;
  }

  return `${(ms / 1_000).toFixed(2)}s`;
}

export type PhaseOutcome = 'ok' | 'error';

export type PhaseRecorder = (input: {
  label: string;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  outcome: PhaseOutcome;
}) => void | Promise<void>;

export async function timedStep<T>(
  logger: StartupLogger,
  label: string,
  fn: () => Promise<T> | T,
  recordPhase?: PhaseRecorder,
): Promise<T> {
  const startedAtMs = Date.now();

  try {
    const result = await fn();
    const endedAtMs = Date.now();
    const durationMs = endedAtMs - startedAtMs;
    logger.debug.log(`${label} (done in ${formatDurationMs(durationMs)})`);

    if (recordPhase) {
      // Fire and forget: phase recording is best-effort and must not change
      // the outcome of the underlying step.
      void Promise.resolve(
        recordPhase({
          label,
          startedAtMs,
          endedAtMs,
          durationMs,
          outcome: 'ok',
        }),
      ).catch(() => {});
    }

    return result;
  } catch (error) {
    const endedAtMs = Date.now();
    const durationMs = endedAtMs - startedAtMs;
    logger.debug.log(`${label} (failed after ${formatDurationMs(durationMs)})`);

    if (recordPhase) {
      void Promise.resolve(
        recordPhase({
          label,
          startedAtMs,
          endedAtMs,
          durationMs,
          outcome: 'error',
        }),
      ).catch(() => {});
    }

    throw error;
  }
}
