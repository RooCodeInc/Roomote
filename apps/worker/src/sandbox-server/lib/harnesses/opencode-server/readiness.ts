interface WaitForOpenCodeServerOptions {
  baseUrl: string;
  timeoutMs: number;
  retryIntervalMs?: number;
  probe?: (signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

function describeProbeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function probeOpenCodeHealth(
  baseUrl: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(`${baseUrl}/global/health`, { signal });

  if (!response.ok) {
    throw new Error(`Health probe returned HTTP ${response.status}.`);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error('OpenCode server readiness wait aborted.');
  }
}

async function waitForRetry(
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        signal?.reason ?? new Error('OpenCode server readiness wait aborted.'),
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);

    if (signal?.aborted) {
      onAbort();
      return;
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function waitForOpenCodeServer({
  baseUrl,
  timeoutMs,
  retryIntervalMs = 100,
  probe = (signal) => probeOpenCodeHealth(baseUrl, signal),
  signal,
}: WaitForOpenCodeServerOptions): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const remainingMs = deadline - Date.now();
    const probeSignal = signal
      ? AbortSignal.any([
          signal,
          AbortSignal.timeout(Math.min(1_000, remainingMs)),
        ])
      : AbortSignal.timeout(Math.min(1_000, remainingMs));

    try {
      await probe(probeSignal);
      return;
    } catch (error) {
      throwIfAborted(signal);
      lastError = error;
    }

    const delayMs = Math.min(retryIntervalMs, deadline - Date.now());

    if (delayMs > 0) {
      await waitForRetry(delayMs, signal);
    }
  }

  const lastErrorMessage = lastError
    ? ` Last probe error: ${describeProbeError(lastError)}`
    : '';
  throw new Error(
    `Timed out waiting for OpenCode server readiness at ${baseUrl}.${lastErrorMessage}`,
  );
}
