export function toAbortError(
  signal?: AbortSignal,
  message = 'Operation aborted',
): Error {
  const reason = signal?.reason;

  if (reason instanceof Error) {
    if (reason.name === 'AbortError') {
      return reason;
    }

    const abortError = new Error(reason.message, { cause: reason });
    abortError.name = 'AbortError';
    return abortError;
  }

  const reasonSuffix =
    typeof reason === 'string' && reason.length > 0 ? `: ${reason}` : '';
  const abortError = new Error(`${message}${reasonSuffix}`);
  abortError.name = 'AbortError';
  return abortError;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function throwIfAborted(signal?: AbortSignal, message?: string): void {
  if (signal?.aborted) {
    throw toAbortError(signal, message);
  }
}

export function sleepWithSignal(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
      reject(toAbortError(signal));
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function raceWithAbort<T>(options: {
  promise: Promise<T>;
  signal?: AbortSignal;
  abortMessage?: string;
  onLateResolve?: (value: T) => Promise<void> | void;
  onLateReject?: (error: unknown) => Promise<void> | void;
}): Promise<T> {
  const { promise, signal, abortMessage, onLateResolve, onLateReject } =
    options;

  throwIfAborted(signal, abortMessage);

  if (!signal) {
    return promise;
  }

  return await new Promise<T>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(toAbortError(signal, abortMessage));
    };

    signal.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (value) => {
        if (settled || signal.aborted) {
          Promise.resolve(onLateResolve?.(value)).catch(() => {
            // Callers log late cleanup failures.
          });
          return;
        }

        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled || signal.aborted) {
          Promise.resolve(onLateReject?.(error)).catch(() => {
            // Callers log late cleanup failures.
          });
          return;
        }

        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}
