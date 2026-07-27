import { logger } from '@/lib/server/logger';

/**
 * Server-side latency instrumentation for the tRPC HTTP route.
 *
 * The goal is to localize unexplained request latency: every HTTP request to
 * `/api/trpc` emits exactly one `[request-timing]` line, and individually slow
 * procedures emit a threshold-gated `[procedure-timing]` line. Comparing the
 * handler duration against the client-observed duration tells us whether the
 * time is spent inside our code or somewhere around it (Next.js routing,
 * container CPU, proxy, TLS).
 *
 * Logging rules: procedure NAMES, durations, status codes and the request
 * pathname only. Never inputs, user ids, headers or any other request payload.
 */

const DEFAULT_SLOW_PROCEDURE_LOG_MS = 250;
const SLOW_PROCEDURE_LOG_MS_ENV_KEY = 'R_SLOW_PROCEDURE_LOG_MS';

/**
 * Procedure names come off the URL, so they are attacker-controlled. Strip
 * anything outside the tRPC path alphabet and cap the joined list so a crafted
 * URL cannot inject newlines into the log or blow up a line's size.
 */
const PROCEDURE_NAME_DISALLOWED = /[^A-Za-z0-9._-]/g;
const MAX_PROCEDURE_LIST_CHARS = 200;

function formatMs(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function sanitizeProcedureName(name: string): string {
  return name.replace(PROCEDURE_NAME_DISALLOWED, '');
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Reads the slow-procedure threshold from the environment on every call so the
 * value can be flipped without a rebuild (and so tests can vary it).
 *
 * - unset / unparseable -> 250ms
 * - `0` -> no threshold, every procedure is logged
 */
export function getSlowProcedureLogThresholdMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[SLOW_PROCEDURE_LOG_MS_ENV_KEY]?.trim();

  if (!raw || !/^\d+$/.test(raw)) {
    return DEFAULT_SLOW_PROCEDURE_LOG_MS;
  }

  const parsed = Number.parseInt(raw, 10);

  return Number.isFinite(parsed) ? parsed : DEFAULT_SLOW_PROCEDURE_LOG_MS;
}

function logProcedureTiming({
  path,
  durationMs,
  ok,
}: {
  path: string;
  durationMs: number;
  ok: boolean;
}): void {
  if (durationMs < getSlowProcedureLogThresholdMs()) {
    return;
  }

  logger.info(
    `[procedure-timing] procedure=${sanitizeProcedureName(path)} ms=${formatMs(durationMs)} ok=${ok}`,
  );
}

/**
 * Times a single procedure call. Returns the middleware result untouched and
 * re-throws whatever it caught, so it can never alter behavior.
 *
 * Note that tRPC's middleware chain converts downstream throws into
 * `{ ok: false }` results rather than rejections, so both shapes are handled.
 */
export async function withProcedureTiming<TResult extends { ok: boolean }>(
  path: string,
  next: () => Promise<TResult>,
): Promise<TResult> {
  const startedAt = performance.now();

  try {
    const result = await next();

    logProcedureTiming({
      path,
      durationMs: performance.now() - startedAt,
      ok: result.ok,
    });

    return result;
  } catch (error) {
    logProcedureTiming({
      path,
      durationMs: performance.now() - startedAt,
      ok: false,
    });

    throw error;
  }
}

/**
 * Derives the requested procedures from the tRPC URL
 * (`/api/trpc/foo.bar,baz.qux`) without touching the request body.
 */
export function describeRequestProcedures(url: URL): {
  procedures: string;
  batch: number;
} {
  const trailing = url.pathname.split('/api/trpc/')[1] ?? '';
  const names = trailing
    .split(',')
    .map((name) => sanitizeProcedureName(safeDecode(name)))
    .filter((name) => name.length > 0);

  if (names.length === 0) {
    return { procedures: 'none', batch: 0 };
  }

  const joined = names.join(',');

  return {
    procedures:
      joined.length > MAX_PROCEDURE_LIST_CHARS
        ? `${names.length}-procedures`
        : joined,
    batch: names.length,
  };
}

/**
 * `Server-Timing` value emitted from `responseMeta`.
 *
 * The client uses `httpBatchStreamLink`, so tRPC generates response metadata
 * eagerly — before any procedure has resolved. Only the context/auth phase is
 * genuinely known at that point, and we must not block the stream to learn
 * more, so this deliberately carries a single metric. The handler total is
 * appended later (see `withResponseCompletionTiming`), which is still before
 * the headers go out.
 */
export function buildAuthServerTiming(authMs: number | null): string | null {
  return authMs === null ? null : `auth;dur=${formatMs(authMs)}`;
}

export function buildHandlerServerTiming(handlerMs: number): string {
  return `handler;dur=${formatMs(handlerMs)}`;
}

/**
 * Wraps the response body in a pass-through stream so we can observe when the
 * response is fully flushed. The stream is pull-based, so backpressure and
 * chunk boundaries are preserved and nothing is buffered or delayed; the only
 * added work is one callback when the body ends, errors or is cancelled.
 */
export function withResponseCompletionTiming(
  response: Response,
  onComplete: () => void,
): Response {
  const body = response.body;

  if (!body) {
    onComplete();
    return response;
  }

  let settled = false;

  const finish = () => {
    if (settled) {
      return;
    }

    settled = true;

    try {
      onComplete();
    } catch {
      // Instrumentation must never break the response stream.
    }
  };

  try {
    const reader = body.getReader();

    const measured = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();

          if (done) {
            controller.close();
            finish();
            return;
          }

          controller.enqueue(value);
        } catch (error) {
          finish();
          controller.error(error);
        }
      },
      cancel(reason) {
        finish();
        return reader.cancel(reason);
      },
    });

    return new Response(measured, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch {
    // Never let instrumentation break a response.
    finish();
    return response;
  }
}

/**
 * The single per-request log line. One line per HTTP request, so volume is
 * bounded by traffic.
 *
 * - `auth`    time spent in `createContext` (runs even for requests that are
 *             rejected as unauthenticated)
 * - `handler` time inside our exported route handler, entry to return
 * - `total`   entry until the response body is fully flushed; for streamed
 *             batches this is the number to compare against what the client
 *             observes, since `handler` ends when the headers are ready
 */
export function logRequestTiming({
  path,
  procedures,
  batch,
  authMs,
  handlerMs,
  totalMs,
  status,
}: {
  path: string;
  procedures: string;
  batch: number;
  authMs: number | null;
  handlerMs: number;
  totalMs: number;
  status: number;
}): void {
  logger.info(
    `[request-timing] path=${path} procedures=${procedures} auth=${
      authMs === null ? 'n/a' : formatMs(authMs)
    } handler=${formatMs(handlerMs)} status=${status} batch=${batch} total=${formatMs(totalMs)}`,
  );
}
