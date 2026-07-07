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
