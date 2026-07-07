interface RetryAttemptContext<TResult> {
  attemptNumber: number;
  maxAttempts: number;
  error?: unknown;
  result?: TResult;
}

interface RetryOptions<TResult> {
  maxAttempts: number;
  signal?: AbortSignal | null;
  getDelayMs?: (attemptNumber: number) => number;
  shouldRetry: (
    context: RetryAttemptContext<TResult>,
  ) => boolean | Promise<boolean>;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

async function sleepWithSignal(
  delayMs: number,
  signal?: AbortSignal | null,
): Promise<void> {
  if (delayMs <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);

    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException('The operation was aborted', 'AbortError'),
      );
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function retryAsync<TResult>(
  execute: () => Promise<TResult>,
  options: RetryOptions<TResult>,
): Promise<TResult> {
  const { maxAttempts, signal, shouldRetry, getDelayMs = () => 0 } = options;

  if (maxAttempts < 1) {
    throw new Error('maxAttempts must be at least 1');
  }

  for (
    let attemptNumber = 1;
    attemptNumber <= maxAttempts;
    attemptNumber += 1
  ) {
    try {
      const result = await execute();
      const canRetry = attemptNumber < maxAttempts;

      if (
        canRetry &&
        (await shouldRetry({
          attemptNumber,
          maxAttempts,
          result,
        }))
      ) {
        await sleepWithSignal(getDelayMs(attemptNumber), signal);
        continue;
      }

      return result;
    } catch (error) {
      if (isAbortError(error) || attemptNumber >= maxAttempts) {
        throw error;
      }

      if (
        !(await shouldRetry({
          attemptNumber,
          maxAttempts,
          error,
        }))
      ) {
        throw error;
      }

      await sleepWithSignal(getDelayMs(attemptNumber), signal);
    }
  }

  throw new Error('Unreachable retry loop');
}
