const SECOND = 1_000;

const MINUTE = 60 * SECOND;

export const SANDBOX_PHASE_MAX_RETRIES = 3;

export const SANDBOX_PHASE_INITIAL_RETRY_DELAY_MS = 2_000;

export const SANDBOX_CREATE_ATTEMPT_TIMEOUT_MS = 30_000;

export const SANDBOX_WRITE_FILES_TIMEOUT_MS = 60_000;

export const SANDBOX_INSTALL_TIMEOUT_MS = 60_000;

export const SANDBOX_WORKER_LAUNCH_TIMEOUT_MS = 20_000;

export const SANDBOX_RESUME_WORKER_LAUNCH_TIMEOUT_MS = 120_000;

export const SANDBOX_MAX_WORKER_LAUNCH_TIMEOUT_MS = Math.max(
  SANDBOX_WORKER_LAUNCH_TIMEOUT_MS,
  SANDBOX_RESUME_WORKER_LAUNCH_TIMEOUT_MS,
);

export const SANDBOX_SPAWN_MAX_ATTEMPTS = 2;

export const SANDBOX_SPAWN_RETRY_DELAY_MS = 5_000;

export const SANDBOX_ORPHAN_SCAN_INTERVAL_MS = 30_000;

// Once infrastructure is ready, a healthy worker should claim its run within
// seconds. Keep this separate from the full spawn envelope so a dead worker
// does not leave the UI in "booting environment" until orphan recovery.
export const WORKER_BOOTSTRAP_CLAIM_TIMEOUT_MS = 2 * MINUTE;

function getExponentialBackoffTotalMs(
  retryCount: number,
  initialDelayMs: number,
): number {
  let totalDelayMs = 0;

  for (let attempt = 1; attempt < retryCount; attempt++) {
    totalDelayMs += initialDelayMs * Math.pow(2, attempt - 1);
  }

  return totalDelayMs;
}

export const SANDBOX_CREATE_PHASE_MAX_DURATION_MS =
  SANDBOX_PHASE_MAX_RETRIES * SANDBOX_CREATE_ATTEMPT_TIMEOUT_MS +
  getExponentialBackoffTotalMs(
    SANDBOX_PHASE_MAX_RETRIES,
    SANDBOX_PHASE_INITIAL_RETRY_DELAY_MS,
  );

export const SANDBOX_WRITE_PHASE_MAX_DURATION_MS =
  SANDBOX_PHASE_MAX_RETRIES * SANDBOX_WRITE_FILES_TIMEOUT_MS +
  getExponentialBackoffTotalMs(
    SANDBOX_PHASE_MAX_RETRIES,
    SANDBOX_PHASE_INITIAL_RETRY_DELAY_MS,
  );

export const SANDBOX_SPAWN_ATTEMPT_MAX_DURATION_MS =
  SANDBOX_CREATE_PHASE_MAX_DURATION_MS +
  SANDBOX_WRITE_PHASE_MAX_DURATION_MS +
  SANDBOX_INSTALL_TIMEOUT_MS +
  SANDBOX_MAX_WORKER_LAUNCH_TIMEOUT_MS;

export const SANDBOX_SPAWN_MAX_DURATION_MS =
  SANDBOX_SPAWN_MAX_ATTEMPTS * SANDBOX_SPAWN_ATTEMPT_MAX_DURATION_MS +
  (SANDBOX_SPAWN_MAX_ATTEMPTS - 1) * SANDBOX_SPAWN_RETRY_DELAY_MS;

export const ORPHANED_PENDING_THRESHOLD_MS = 5 * MINUTE;
export const ORPHANED_AFTER_DEQUEUE_THRESHOLD_MS =
  SANDBOX_SPAWN_MAX_DURATION_MS + SANDBOX_ORPHAN_SCAN_INTERVAL_MS;

export const STUCK_AFTER_DEQUEUE_THRESHOLD_MS =
  ORPHANED_AFTER_DEQUEUE_THRESHOLD_MS + SANDBOX_ORPHAN_SCAN_INTERVAL_MS;

export const STUCK_AFTER_DEQUEUE_THRESHOLD_MINUTES = Math.ceil(
  STUCK_AFTER_DEQUEUE_THRESHOLD_MS / MINUTE,
);

export const STUCK_IN_QUEUE_THRESHOLD_MINUTES = 60;

const NON_RETRYABLE_SPAWN_ERROR_SYMBOL = Symbol.for(
  'roomote.nonRetryableSpawnError',
);

export class NonRetryableSpawnError extends Error {
  public readonly [NON_RETRYABLE_SPAWN_ERROR_SYMBOL] = true;

  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableSpawnError';
  }
}

export function isNonRetryableSpawnError(
  error: unknown,
): error is NonRetryableSpawnError {
  return Boolean(
    error &&
    typeof error === 'object' &&
    NON_RETRYABLE_SPAWN_ERROR_SYMBOL in error,
  );
}
