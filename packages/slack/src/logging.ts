import { Env } from '@roomote/env';
import { formatErrorForLog } from '@roomote/types';

function isDebugLogsEnabled(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

function isSlackDebugLoggingEnabled(): boolean {
  const effectiveAppEnv = Env.APP_ENV ?? Env.NODE_ENV;
  const slackDebugLogsEnabled = isDebugLogsEnabled(Env.SLACK_DEBUG_LOGS);
  const apiDebugLogsEnabled = isDebugLogsEnabled(Env.API_DEBUG_LOGS);

  return (
    effectiveAppEnv !== 'production' ||
    slackDebugLogsEnabled ||
    apiDebugLogsEnabled
  );
}

export function formatSlackError(error: unknown): string {
  return formatErrorForLog(error);
}

export function slackDebug(...args: Parameters<typeof console.log>): void {
  if (isSlackDebugLoggingEnabled()) {
    console.log(...args);
  }
}

export function logSlackError(prefix: string, error: unknown): void {
  const message = formatErrorForLog(error);
  console.error(`${prefix}: ${message}`);
}
