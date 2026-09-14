import { formatLogFields } from '@roomote/types';

import {
  registerLongLivedProxyStream,
  type LongLivedProxyStreamTrackingContext,
} from './long-lived-proxy-stream-registry';

type ProxyResponseLogFieldValue = number | string | undefined;

function extractErrorFields(
  error: unknown,
): Record<string, ProxyResponseLogFieldValue> {
  if (!(error instanceof Error)) {
    return {
      error: String(error),
    };
  }

  const result: Record<string, ProxyResponseLogFieldValue> = {
    errorName: error.name,
    error: error.message,
  };

  if (
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    result.errorCode = (error as { code: string }).code;
  }

  if (!(error.cause instanceof Error)) {
    return result;
  }

  result.causeName = error.cause.name;
  result.cause = error.cause.message;

  if (
    'code' in error.cause &&
    typeof (error.cause as { code?: unknown }).code === 'string'
  ) {
    result.causeCode = (error.cause as { code: string }).code;
  }

  return result;
}

function isExpectedProxyDisconnect(error: unknown): boolean {
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

export function createLoggedProxyResponseBody(options: {
  body: ReadableStream<Uint8Array> | null;
  logPrefix: string;
  getLogFields: () => Record<string, ProxyResponseLogFieldValue>;
  trackingContext?: LongLivedProxyStreamTrackingContext;
}): ReadableStream<Uint8Array> | null {
  const { body, logPrefix, getLogFields, trackingContext } = options;

  if (!body) {
    return null;
  }

  const reader = body.getReader();
  let released = false;
  let releaseTracking: (() => void) | null = null;

  function releaseReader(): void {
    if (released) {
      return;
    }

    released = true;

    try {
      reader.releaseLock();
    } catch {
      // Ignore release failures from already-closed readers.
    }
  }

  function ensureTrackingStarted(): void {
    if (!trackingContext || releaseTracking) {
      return;
    }

    releaseTracking = registerLongLivedProxyStream(trackingContext);
  }

  function releaseTrackingIfNeeded(): void {
    releaseTracking?.();
    releaseTracking = null;
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        ensureTrackingStarted();
        const { done, value } = await reader.read();

        if (done) {
          releaseTrackingIfNeeded();
          releaseReader();
          controller.close();
          return;
        }

        controller.enqueue(value);
      } catch (error) {
        const message = `${logPrefix} ${formatLogFields({
          ...getLogFields(),
          ...extractErrorFields(error),
        })}`;

        if (isExpectedProxyDisconnect(error)) {
          console.debug(message);
        } else {
          console.error(message);
        }

        releaseTrackingIfNeeded();
        releaseReader();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {
        // Ignore cancellation failures when the upstream stream is already gone.
      }

      releaseTrackingIfNeeded();
      releaseReader();
    },
  });
}

/** SSE comment line; every SSE parser discards comment lines. */
const SSE_KEEPALIVE_CHUNK = new TextEncoder().encode(': keepalive\n\n');

const KEEPALIVE_DUE = Symbol('keepalive-due');

function raceKeepaliveTimer<T>(
  pending: Promise<T>,
  intervalMs: number,
): Promise<T | typeof KEEPALIVE_DUE> {
  let timer: NodeJS.Timeout | undefined;
  const due = new Promise<typeof KEEPALIVE_DUE>((resolve) => {
    timer = setTimeout(() => resolve(KEEPALIVE_DUE), intervalMs);
  });

  return Promise.race([pending, due]).finally(() => clearTimeout(timer));
}

/**
 * Wrap an SSE body so a comment line is emitted whenever the upstream has been
 * silent for `intervalMs`. Provider streams go quiet for a minute or more
 * while a model reasons before its next token, and the edge proxies between
 * a sandbox and this API reset connections that carry no bytes for that long.
 * The client sees the reset as a provider error, aborts every in-flight tool
 * call, and regenerates the whole turn. Comment lines keep the connection
 * busy without changing the event stream the client parses.
 *
 * Upstream reads are driven by downstream `pull`, so a slow client bounds the
 * buffering to the stream's own queue plus one in-flight upstream chunk. A
 * keepalive is only written while the client is waiting on a read.
 */
export function createSseKeepaliveProxyBody(options: {
  body: ReadableStream<Uint8Array> | null;
  intervalMs: number;
}): ReadableStream<Uint8Array> | null {
  const { body, intervalMs } = options;

  if (!body) {
    return null;
  }

  const reader = body.getReader();
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  let closed = false;

  function releaseReader(): void {
    try {
      reader.releaseLock();
    } catch {
      // Ignore release failures from already-closed readers.
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // Keep one upstream read pending across pulls: a keepalive wake-up
        // returns before the read settles, and the next pull resumes waiting
        // on the same read so no upstream bytes are lost or reordered.
        pendingRead ??= reader.read();
        const result = await raceKeepaliveTimer(pendingRead, intervalMs);

        if (closed) {
          return;
        }

        if (result === KEEPALIVE_DUE) {
          controller.enqueue(SSE_KEEPALIVE_CHUNK);
          return;
        }

        pendingRead = null;

        if (result.done) {
          closed = true;
          releaseReader();
          controller.close();
          return;
        }

        controller.enqueue(result.value);
      } catch (error) {
        if (closed) {
          return;
        }

        closed = true;
        releaseReader();
        controller.error(error);
      }
    },
    async cancel(reason) {
      closed = true;

      try {
        await reader.cancel(reason);
      } catch {
        // Ignore cancellation failures when the upstream stream is already gone.
      }

      releaseReader();
    },
  });
}
