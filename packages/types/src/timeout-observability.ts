export type ObservedTimeoutDetails = {
  source: string;
  operation: string;
  durationMs?: number;
  timeoutMs?: number;
  method?: string;
  url?: string;
  timeoutOrigin?: string;
};

const OBSERVED_TIMEOUT_ERROR_SYMBOL = Symbol.for(
  'roomote.observedTimeoutError',
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasFiniteNumber(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  if (isRecord(error) && typeof error.message === 'string') {
    const wrappedError = new Error(error.message);

    if (typeof error.name === 'string' && error.name.length > 0) {
      wrappedError.name = error.name;
    }

    if ('cause' in error) {
      (wrappedError as Error & { cause?: unknown }).cause = error.cause;
    }

    if (typeof error.stack === 'string') {
      wrappedError.stack = error.stack;
    }

    return wrappedError;
  }

  return new Error(String(error));
}

function isTimeoutReason(reason: unknown): reason is Error {
  return reason instanceof Error && reason.name === 'TimeoutError';
}

function formatObservedTimeoutMessage(details: ObservedTimeoutDetails): string {
  const requestDescription =
    details.method && details.url
      ? ` while requesting ${details.method} ${details.url}`
      : '';
  const durationDescription = hasFiniteNumber(details.durationMs)
    ? ` after ${details.durationMs}ms`
    : '';
  const timeoutDescription = hasFiniteNumber(details.timeoutMs)
    ? ` (timeout ${details.timeoutMs}ms)`
    : '';

  return `${details.source} ${details.operation} timed out${requestDescription}${durationDescription}${timeoutDescription}`;
}

export class ObservedTimeoutError extends Error {
  public readonly [OBSERVED_TIMEOUT_ERROR_SYMBOL] = true;
  public readonly source: string;
  public readonly operation: string;
  public readonly durationMs?: number;
  public readonly timeoutMs?: number;
  public readonly method?: string;
  public readonly url?: string;
  public readonly timeoutOrigin?: string;

  constructor(details: ObservedTimeoutDetails) {
    super(formatObservedTimeoutMessage(details));
    this.name = 'ObservedTimeoutError';
    this.source = details.source;
    this.operation = details.operation;
    this.durationMs = details.durationMs;
    this.timeoutMs = details.timeoutMs;
    this.method = details.method;
    this.url = details.url;
    this.timeoutOrigin = details.timeoutOrigin;
  }
}

export function isObservedTimeoutError(
  error: unknown,
): error is ObservedTimeoutError {
  return Boolean(
    error &&
    typeof error === 'object' &&
    OBSERVED_TIMEOUT_ERROR_SYMBOL in error,
  );
}

export function isAbortLikeError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

export function isTimedOutSignal(
  signal?: AbortSignal | null,
): signal is AbortSignal {
  return Boolean(signal?.aborted && isTimeoutReason(signal.reason));
}

export function wrapObservedTimeoutError(options: {
  error: unknown;
  signal?: AbortSignal | null;
  details: ObservedTimeoutDetails;
}): Error {
  const { error, signal, details } = options;

  if (isObservedTimeoutError(error)) {
    return error;
  }

  const resolvedError = toError(error);

  if (!isTimedOutSignal(signal) || !isAbortLikeError(resolvedError)) {
    return resolvedError;
  }

  return new ObservedTimeoutError(details);
}
