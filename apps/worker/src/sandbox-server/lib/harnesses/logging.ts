import type { HarnessLogger } from '../../../logging';

/**
 * Pick<Console>-shaped view that pre-prepends a fixed string tag to every log
 * call. Writes go to the same underlying `HarnessLogger`, so all output still
 * lands in the harness log file.
 */
interface PrefixedLogger {
  log: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export function createPrefixedLogger(
  logger: HarnessLogger,
  prefix: string,
): PrefixedLogger {
  return {
    log: (...args: unknown[]) => logger.log?.(prefix, ...args),
    info: (...args: unknown[]) => logger.info(prefix, ...args),
    warn: (...args: unknown[]) => logger.warn(prefix, ...args),
    error: (...args: unknown[]) => logger.error(prefix, ...args),
  };
}

export function describeUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
