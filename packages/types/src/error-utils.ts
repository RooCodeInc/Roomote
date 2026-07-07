interface ErrorLike extends Error {
  code?: unknown;
  cause?: unknown;
  context?: unknown;
  metadata?: unknown;
  response?: unknown;
  json?: unknown;
  text?: unknown;
  sandboxId?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getResponseHeaders(
  headers: unknown,
): Record<string, string> | undefined {
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (!isRecord(headers) || typeof headers.entries !== 'function') {
    return undefined;
  }

  try {
    const entries = Array.from(
      (
        headers as {
          entries: () => IterableIterator<[string, string]>;
        }
      ).entries(),
    );

    return Object.fromEntries(entries);
  } catch {
    return undefined;
  }
}

function getErrorLikeName(error: unknown): string | undefined {
  if (error instanceof Error && error.name.length > 0) {
    return error.name;
  }

  if (
    isRecord(error) &&
    typeof error.name === 'string' &&
    error.name.length > 0
  ) {
    return error.name;
  }

  return undefined;
}

function getErrorLikeMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (isRecord(error) && typeof error.message === 'string') {
    return error.message;
  }

  return String(error);
}

export function serializeError(error: unknown): {
  name?: string;
  message: string;
} {
  const name = getErrorLikeName(error);
  const message = getErrorLikeMessage(error);

  return name ? { name, message } : { message };
}

export function extractErrorDetails(error: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {
    message: getErrorLikeMessage(error),
  };
  const name = getErrorLikeName(error);

  if (name) {
    result.name = name;
  }

  if (!isRecord(error)) {
    return result;
  }

  const errorLike = error as unknown as ErrorLike;

  if (
    typeof errorLike.code === 'string' ||
    typeof errorLike.code === 'number'
  ) {
    result.code = errorLike.code;
  }

  if (typeof errorLike.sandboxId === 'string') {
    result.sandboxId = errorLike.sandboxId;
  }

  if (typeof errorLike.text === 'string' && errorLike.text.length > 0) {
    result.responseText = errorLike.text;
  }

  if (errorLike.json !== undefined) {
    result.responseJson = errorLike.json;
  }

  if (isRecord(errorLike.response)) {
    if (typeof errorLike.response.status === 'number') {
      result.responseStatus = errorLike.response.status;
    }

    if (typeof errorLike.response.statusText === 'string') {
      result.responseStatusText = errorLike.response.statusText;
    }

    const responseHeaders = getResponseHeaders(errorLike.response.headers);

    if (responseHeaders) {
      result.responseHeaders = responseHeaders;
    }
  }

  if (isRecord(errorLike.context)) {
    result.context = errorLike.context;
  }

  if (isRecord(errorLike.metadata)) {
    result.metadata = errorLike.metadata;
  }

  if (errorLike.cause !== undefined) {
    result.cause = extractErrorDetails(errorLike.cause);
  }

  return result;
}
