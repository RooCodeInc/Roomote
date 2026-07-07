import type { IncomingMessage, ServerResponse } from 'http';
import { logger, escapeForLog } from './logger';
import { getHeaderValue } from './request-correlation';
import { getRequestContext } from './request-context';

export interface AccessLogContext {
  startTime: bigint;
  req: IncomingMessage;
  upstreamStatusCode?: number;
  upstreamError?: string;
  upstreamTarget?: string;
  outcome?: string;
  clientError?: string;
  logged?: boolean;
}

/**
 * Create an access log context for an HTTP request.
 * Attaches `finish` and `close` listeners on `res` so a single structured
 * log line is emitted once the response completes (or the client disconnects).
 */
export function createAccessLog(
  req: IncomingMessage,
  res: ServerResponse,
): AccessLogContext {
  const ctx: AccessLogContext = {
    startTime: process.hrtime.bigint(),
    req,
  };

  res.on('finish', () => {
    emitAccessLog(ctx, res);
  });

  res.on('close', () => {
    if (!res.writableFinished) {
      ctx.clientError = 'connection_closed';
      emitAccessLog(ctx, res);
    }
  });

  return ctx;
}

function emitAccessLog(ctx: AccessLogContext, res: ServerResponse): void {
  if (ctx.logged) return;
  ctx.logged = true;

  const durationMs = Number(process.hrtime.bigint() - ctx.startTime) / 1e6;
  const requestContext = getRequestContext();
  const requestId =
    requestContext?.requestId ??
    getHeaderValue(ctx.req.headers, 'x-request-id');
  const traceparent =
    requestContext?.traceparent ??
    getHeaderValue(ctx.req.headers, 'traceparent');
  const flyRequestId = getHeaderValue(ctx.req.headers, 'fly-request-id');

  const fields = {
    method: ctx.req.method,
    path: ctx.req.url,
    host: escapeForLog(ctx.req.headers.host || 'unknown'),
    requestId: requestId ? escapeForLog(requestId) : undefined,
    traceparent: traceparent ? escapeForLog(traceparent) : undefined,
    flyRequestId: flyRequestId ? escapeForLog(flyRequestId) : undefined,
    statusCode: res.statusCode,
    clientError: ctx.clientError,
    upstreamStatusCode: ctx.upstreamStatusCode,
    upstreamError: ctx.upstreamError,
    upstreamTarget: ctx.upstreamTarget
      ? escapeForLog(ctx.upstreamTarget)
      : undefined,
    durationMs: Math.round(durationMs),
    outcome: ctx.outcome || 'unknown',
  };

  logger.info(fields, 'access');
}

/**
 * Emit a WebSocket access log entry. WebSocket upgrades don't have a
 * `ServerResponse`, so this is called explicitly at each return point.
 */
export function emitWsAccessLog(
  req: IncomingMessage,
  fields: {
    outcome: string;
    upstreamTarget?: string;
    upstreamError?: string;
    durationMs: number;
    statusCode?: number;
  },
): void {
  const requestContext = getRequestContext();
  const requestId =
    requestContext?.requestId ?? getHeaderValue(req.headers, 'x-request-id');
  const traceparent =
    requestContext?.traceparent ?? getHeaderValue(req.headers, 'traceparent');
  const flyRequestId = getHeaderValue(req.headers, 'fly-request-id');

  const logFields = {
    method: req.method,
    path: req.url,
    host: escapeForLog(req.headers.host || 'unknown'),
    requestId: requestId ? escapeForLog(requestId) : undefined,
    traceparent: traceparent ? escapeForLog(traceparent) : undefined,
    flyRequestId: flyRequestId ? escapeForLog(flyRequestId) : undefined,
    statusCode: fields.statusCode,
    upstreamTarget: fields.upstreamTarget
      ? escapeForLog(fields.upstreamTarget)
      : undefined,
    upstreamError: fields.upstreamError,
    durationMs: Math.round(fields.durationMs),
    outcome: fields.outcome,
  };

  logger.info(logFields, 'ws_access');
}
