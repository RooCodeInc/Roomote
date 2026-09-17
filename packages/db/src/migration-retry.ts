/**
 * Retry policy for the Docker migration runner. Connection drops mid-migration
 * are safe to retry because drizzle applies the whole batch in one transaction.
 *
 * postgres.js has an open upstream bug (porsager/postgres#1208, #1154) where a
 * write queued on a connection the server just closed throws
 * `TypeError: Cannot read properties of null (reading 'write')` as an
 * uncaughtException instead of rejecting the query, so the runner has to treat
 * that shape as a connection error too and catch it at the process level.
 */

const CONNECTION_ERROR_CODES = new Set([
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'CONNECT_TIMEOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  // Postgres "connection_exception" class (08xxx), e.g. 57P01 admin shutdown
  // is covered below.
  '08000',
  '08003',
  '08006',
  '57P01',
  '57P02',
  '57P03',
]);

const NULL_SOCKET_WRITE_PATTERN =
  /Cannot read properties of null \(reading 'write'\)|null is not an object \(evaluating 'socket\.write'\)/;

export function isRetryableConnectionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const code = (error as { code?: unknown }).code;

  if (typeof code === 'string' && CONNECTION_ERROR_CODES.has(code)) {
    return true;
  }

  if (
    error instanceof TypeError &&
    NULL_SOCKET_WRITE_PATTERN.test(error.message)
  ) {
    return true;
  }

  return false;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string'
      ? `${code}: ${error.message}`
      : error.message;
  }

  return String(error);
}

interface RetryOptions {
  maxAttempts: number;
  delayMs: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (error: unknown, attempt: number, maxAttempts: number) => void;
}

/**
 * Runs `attempt` until it resolves, retrying only on retryable connection
 * errors up to `maxAttempts` times. Any other error, or the final connection
 * error, is rethrown unchanged.
 */
export async function retryOnConnectionError<T>(
  attempt: () => Promise<T>,
  { maxAttempts, delayMs, sleep = defaultSleep, onRetry }: RetryOptions,
): Promise<T> {
  for (let attemptNumber = 1; ; attemptNumber++) {
    try {
      return await attempt();
    } catch (error) {
      if (attemptNumber >= maxAttempts || !isRetryableConnectionError(error)) {
        throw error;
      }

      onRetry?.(error, attemptNumber, maxAttempts);
      await sleep(delayMs * attemptNumber);
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
