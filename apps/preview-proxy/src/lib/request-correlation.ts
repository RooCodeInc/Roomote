import crypto from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';

import type { RequestContext } from './request-context';

const TRACEPARENT_REGEX = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

interface ResolvedRequestCorrelation {
  requestContext: RequestContext;
  dropTracestate: boolean;
}

function isAllZeroHex(value: string): boolean {
  return /^0+$/.test(value);
}

function randomHex(byteLength: number): string {
  let value = '';

  while (value.length === 0 || isAllZeroHex(value)) {
    value = crypto.randomBytes(byteLength).toString('hex');
  }

  return value;
}

export function getHeaderValue(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const value = headers[name];

  if (Array.isArray(value)) {
    return value.find((entry) => entry.trim().length > 0)?.trim();
  }

  if (typeof value === 'string') {
    const normalizedValue = value.trim();
    return normalizedValue.length > 0 ? normalizedValue : undefined;
  }

  return undefined;
}

export function isValidTraceparent(value: string): boolean {
  const match = value.match(TRACEPARENT_REGEX);
  if (!match) {
    return false;
  }

  const [, traceId, parentId] = match;
  if (!traceId || !parentId) {
    return false;
  }

  return !isAllZeroHex(traceId) && !isAllZeroHex(parentId);
}

export function generateTraceparent(): string {
  return `00-${randomHex(16)}-${randomHex(8)}-01`;
}

export function resolveRequestCorrelation(
  req: IncomingMessage,
): ResolvedRequestCorrelation {
  const requestId =
    getHeaderValue(req.headers, 'x-request-id') ?? crypto.randomUUID();
  const incomingTraceparent = getHeaderValue(req.headers, 'traceparent');
  const hasValidTraceparent =
    incomingTraceparent !== undefined &&
    isValidTraceparent(incomingTraceparent);

  return {
    requestContext: {
      requestId,
      traceparent: hasValidTraceparent
        ? incomingTraceparent
        : generateTraceparent(),
      host: getHeaderValue(req.headers, 'host'),
      method: req.method,
      path: req.url,
    },
    dropTracestate: !hasValidTraceparent,
  };
}
