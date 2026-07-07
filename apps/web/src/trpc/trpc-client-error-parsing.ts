export type NestedTrpcResponseShape = 'batch' | 'single' | 'unknown';

export type NestedTrpcClientErrorDetails = {
  message: string;
  nestedTrpc: {
    responseShape: NestedTrpcResponseShape;
    responseStatus: number | null;
    errorCode: number | null;
    httpStatus: number | null;
    path: string | null;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function looksLikeSerializedJson(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function getErrorMeta(error: unknown): Record<string, unknown> | null {
  if (!isRecord(error) || !isRecord(error.meta)) {
    return null;
  }

  return error.meta;
}

function getNestedTrpcResponseStatus(error: unknown): number | null {
  const meta = getErrorMeta(error);

  if (!meta || !isRecord(meta.response)) {
    return null;
  }

  return typeof meta.response.status === 'number' ? meta.response.status : null;
}

function parseNestedTrpcErrorCandidate(
  candidate: unknown,
  responseShape: NestedTrpcResponseShape = 'unknown',
): {
  message: string;
  responseShape: NestedTrpcResponseShape;
  errorCode: number | null;
  httpStatus: number | null;
  path: string | null;
} | null {
  if (typeof candidate === 'string') {
    if (!looksLikeSerializedJson(candidate)) {
      return null;
    }

    try {
      return parseNestedTrpcErrorCandidate(
        JSON.parse(candidate),
        responseShape,
      );
    } catch {
      return null;
    }
  }

  if (Array.isArray(candidate)) {
    for (const item of candidate) {
      const parsed = parseNestedTrpcErrorCandidate(item, 'batch');

      if (parsed) {
        return parsed;
      }
    }

    return null;
  }

  if (!isRecord(candidate) || !isRecord(candidate.error)) {
    return null;
  }

  const error = candidate.error;
  const data = isRecord(error.data) ? error.data : null;

  if (typeof error.message !== 'string') {
    return null;
  }

  return {
    message: error.message,
    responseShape,
    errorCode: typeof error.code === 'number' ? error.code : null,
    httpStatus: typeof data?.httpStatus === 'number' ? data.httpStatus : null,
    path: typeof data?.path === 'string' ? data.path : null,
  };
}

export function buildNestedTrpcClientErrorDetails(
  error: unknown,
): NestedTrpcClientErrorDetails | null {
  if (!(error instanceof Error)) {
    return null;
  }

  const meta = getErrorMeta(error);
  const responseJson = meta?.responseJSON;
  const parsed =
    parseNestedTrpcErrorCandidate(
      responseJson,
      Array.isArray(responseJson) ? 'batch' : 'single',
    ) ??
    parseNestedTrpcErrorCandidate(error.message) ??
    parseNestedTrpcErrorCandidate(
      error.cause instanceof Error ? error.cause.message : null,
    );

  if (!parsed) {
    return null;
  }

  return {
    message: parsed.message,
    nestedTrpc: {
      responseShape: parsed.responseShape,
      responseStatus: getNestedTrpcResponseStatus(error),
      errorCode: parsed.errorCode,
      httpStatus: parsed.httpStatus,
      path: parsed.path,
    },
  };
}
