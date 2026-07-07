import { formatErrorForLog, formatSingleLineLog } from '@roomote/types';
import { Env } from '@roomote/env';

function isApiDebugLoggingEnabled(): boolean {
  const effectiveAppEnv = Env.APP_ENV ?? Env.NODE_ENV;

  return (
    effectiveAppEnv !== 'production' ||
    Env.API_DEBUG_LOGS === '1' ||
    Env.API_DEBUG_LOGS === 'true'
  );
}

function isStructuredLogFields(
  value: unknown,
): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export const apiLogger = {
  debug: (...args: Parameters<typeof console.log>) => {
    if (isApiDebugLoggingEnabled()) {
      console.log(...args);
    }
  },
  info: (...args: Parameters<typeof console.info>) => console.info(...args),
  warn: (...args: Parameters<typeof console.warn>) => console.warn(...args),
  error: (...args: Parameters<typeof console.error>) => console.error(...args),
};

export function logApiError(prefix: string, error: unknown): void {
  const message = formatErrorForLog(error);
  apiLogger.error(`${prefix}: ${message}`);
}

export function createSingleLineWarnLogger(): Pick<Console, 'warn'> {
  return {
    warn: (...args: Parameters<typeof console.warn>) => {
      const [message, details, ...rest] = args;

      if (
        typeof message === 'string' &&
        isStructuredLogFields(details) &&
        rest.length === 0
      ) {
        apiLogger.warn(formatSingleLineLog(message, details));
        return;
      }

      apiLogger.warn(...args);
    },
  };
}
