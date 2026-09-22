export type ProxyFailureOutcome =
  | 'client_cancelled'
  | 'timeout'
  | 'transport_abort'
  | 'transport_error';

export type ProxyFailureClassification = {
  outcome: ProxyFailureOutcome;
  expected: boolean;
  retryable: boolean;
};

export type ProxyFailureErrorFields = Record<string, string | undefined>;

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function getProxyFailureErrorFields(
  error: unknown,
): ProxyFailureErrorFields {
  if (!(error instanceof Error)) {
    return { error: String(error) };
  }

  const fields: ProxyFailureErrorFields = {
    errorName: error.name,
    error: error.message,
  };
  const code = errorCode(error);
  if (code) {
    fields.errorCode = code;
  }

  if (error.cause instanceof Error) {
    fields.causeName = error.cause.name;
    fields.cause = error.cause.message;
    const causeCode = errorCode(error.cause);
    if (causeCode) {
      fields.causeCode = causeCode;
    }
  }

  return fields;
}

function isTimeoutError(error: unknown): boolean {
  if (!error) {
    return false;
  }

  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return true;
  }

  if (error instanceof Error) {
    return (
      error.name === 'TimeoutError' ||
      errorCode(error) === 'UND_ERR_HEADERS_TIMEOUT' ||
      errorCode(error) === 'UND_ERR_BODY_TIMEOUT' ||
      /(?:timed out|timeout)/iu.test(error.message) ||
      isTimeoutError(error.cause)
    );
  }

  return false;
}

function isAbortError(error: unknown): boolean {
  if (!error) {
    return false;
  }

  if (
    error instanceof DOMException &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  ) {
    return true;
  }

  if (error instanceof Error) {
    return (
      error.name === 'AbortError' ||
      error.name === 'TimeoutError' ||
      errorCode(error) === 'UND_ERR_ABORTED' ||
      /^aborted$/iu.test(error.message) ||
      isAbortError(error.cause)
    );
  }

  return false;
}

function isExpectedAbortError(error: unknown): boolean {
  if (
    error instanceof DOMException &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  ) {
    return true;
  }

  return (
    error instanceof Error &&
    error.cause instanceof DOMException &&
    (error.cause.name === 'AbortError' || error.cause.name === 'TimeoutError')
  );
}

export function classifyProxyFailure(
  error: unknown,
  signal?: AbortSignal,
): ProxyFailureClassification {
  const timeout = isTimeoutError(signal?.reason) || isTimeoutError(error);

  if (signal?.aborted) {
    return timeout
      ? { outcome: 'timeout', expected: true, retryable: true }
      : { outcome: 'client_cancelled', expected: true, retryable: false };
  }

  if (timeout) {
    return {
      outcome: 'timeout',
      expected: isExpectedAbortError(error),
      retryable: true,
    };
  }

  if (isExpectedAbortError(error)) {
    return { outcome: 'client_cancelled', expected: true, retryable: false };
  }

  if (isAbortError(error)) {
    return { outcome: 'transport_abort', expected: false, retryable: true };
  }

  return { outcome: 'transport_error', expected: false, retryable: true };
}
