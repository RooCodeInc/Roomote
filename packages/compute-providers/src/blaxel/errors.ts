import { extractErrorDetails, serializeError } from '@roomote/types';

export interface BlaxelErrorDetails {
  code?: string | number;
  message: string;
  origin?: string;
  retryable?: boolean;
  status?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseEmbeddedJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null;

  const jsonStart = value.indexOf('{');
  if (jsonStart < 0) return null;

  try {
    const parsed: unknown = JSON.parse(value.slice(jsonStart));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function unwrapErrorPayload(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return isRecord(value.error) ? value.error : value;
}

function readHeaderOrigin(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;

  for (const [name, headerValue] of Object.entries(value)) {
    if (
      name.toLowerCase() === 'x-blaxel-source' &&
      typeof headerValue === 'string'
    ) {
      return headerValue;
    }
  }

  return undefined;
}

/** Normalizes Blaxel SDK errors, including JSON embedded in Error messages. */
export function getBlaxelErrorDetails(error: unknown): BlaxelErrorDetails {
  const extracted = extractErrorDetails(error);
  const extractedCause = isRecord(extracted.cause)
    ? extracted.cause
    : undefined;
  const directCause = isRecord(error) ? error.cause : undefined;
  const serialized = serializeError(error);
  const candidates = [
    unwrapErrorPayload(error),
    unwrapErrorPayload(directCause),
    unwrapErrorPayload(extracted.responseJson),
    unwrapErrorPayload(extractedCause?.responseJson),
    unwrapErrorPayload(extractedCause),
    unwrapErrorPayload(parseEmbeddedJson(extracted.responseText)),
    unwrapErrorPayload(parseEmbeddedJson(extractedCause?.responseText)),
    unwrapErrorPayload(parseEmbeddedJson(extractedCause?.message)),
    unwrapErrorPayload(parseEmbeddedJson(serialized.message)),
  ].filter((candidate): candidate is Record<string, unknown> =>
    Boolean(candidate),
  );

  let code: string | number | undefined;
  let message = serialized.message;
  let origin =
    readHeaderOrigin(extracted.responseHeaders) ??
    readHeaderOrigin(extractedCause?.responseHeaders);
  let retryable: boolean | undefined;
  let status: number | undefined;

  for (const candidate of candidates) {
    if (
      code === undefined &&
      (typeof candidate.code === 'string' || typeof candidate.code === 'number')
    ) {
      code = candidate.code;
    }
    if (typeof candidate.message === 'string') message = candidate.message;
    if (origin === undefined && typeof candidate.origin === 'string') {
      origin = candidate.origin;
    }
    if (retryable === undefined && typeof candidate.retryable === 'boolean') {
      retryable = candidate.retryable;
    }
    if (status === undefined && typeof candidate.status === 'number') {
      status = candidate.status;
    }
  }

  if (code === undefined) {
    const extractedCode = extracted.code;
    if (
      typeof extractedCode === 'string' ||
      typeof extractedCode === 'number'
    ) {
      code = extractedCode;
    }
  }
  if (status === undefined && typeof extracted.responseStatus === 'number') {
    status = extracted.responseStatus;
  }

  return { code, message, origin, retryable, status };
}

function hasPlatformOrigin(details: BlaxelErrorDetails): boolean {
  return (
    details.origin === undefined || details.origin.toLowerCase() === 'platform'
  );
}

export function isBlaxelWorkloadUnavailable(error: unknown): boolean {
  const details = getBlaxelErrorDetails(error);
  return (
    details.code === 'WORKLOAD_UNAVAILABLE' &&
    details.retryable !== false &&
    hasPlatformOrigin(details)
  );
}

export function isBlaxelResourceNotFound(error: unknown): boolean {
  const details = getBlaxelErrorDetails(error);

  if (!hasPlatformOrigin(details)) return false;
  if (details.code === 'WORKLOAD_NOT_FOUND') return true;
  if (typeof details.code === 'string') return false;

  return (
    details.code === 404 ||
    details.status === 404 ||
    details.message.toLowerCase().includes('not found')
  );
}

/** Whether the outer lifecycle retry may safely repeat this operation. */
export function shouldRetryBlaxelLifecycleError(error: unknown): boolean {
  const details = getBlaxelErrorDetails(error);

  if (details.retryable === false) return false;

  if (
    details.origin !== undefined &&
    details.origin.toLowerCase() !== 'platform'
  ) {
    return false;
  }

  if (
    ['WORKLOAD_UNAVAILABLE', 'WORKLOAD_NOT_FOUND', 'ROUTE_NOT_FOUND'].includes(
      String(details.code),
    )
  ) {
    return false;
  }

  const httpStatus =
    details.status ??
    (typeof details.code === 'number' &&
    details.code >= 100 &&
    details.code <= 599
      ? details.code
      : undefined);
  if (
    httpStatus !== undefined &&
    httpStatus >= 400 &&
    httpStatus < 500 &&
    httpStatus !== 408 &&
    httpStatus !== 429
  ) {
    return false;
  }

  return true;
}
