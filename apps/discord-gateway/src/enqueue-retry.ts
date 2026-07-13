const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 100;
const DEFAULT_MAX_DELAY_MS = 1_000;

type EnqueueRetryOptions = {
  enqueue: () => Promise<boolean>;
  signal: AbortSignal;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('Discord Gateway enqueue aborted');
}

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortReason(signal);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    timeout.unref();

    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Retry a transient Redis enqueue without retrying duplicate results. */
export async function enqueueDiscordInboundWithRetry(
  options: EnqueueRetryOptions,
): Promise<boolean> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const baseDelayMs = Math.max(1, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
  const maxDelayMs = Math.max(
    baseDelayMs,
    options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
  );
  const waitForRetry = options.wait ?? wait;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal.aborted) throw abortReason(options.signal);
    try {
      return await options.enqueue();
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;
      await waitForRetry(
        Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs),
        options.signal,
      );
    }
  }

  throw new Error(
    `Discord inbound enqueue failed after ${maxAttempts} attempts`,
    { cause: lastError },
  );
}
