import { setTimeout as delay } from 'node:timers/promises';

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

export async function waitForOpenCodeServer({
  baseUrl,
  timeoutMs,
  retryIntervalMs = 100,
  probe = (signal) => probeOpenCodeHealth(baseUrl, signal),
  signal,
}: WaitForOpenCodeServerOptions): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (true) {
    signal?.throwIfAborted();
    const remainingMs = deadline - Date.now();

    if (remainingMs <= 0) {
      break;
    }

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
      signal?.throwIfAborted();
      lastError = error;
    }

    const delayMs = Math.min(retryIntervalMs, deadline - Date.now());

    if (delayMs <= 0) {
      break;
    }

    await delay(delayMs, undefined, { signal });
  }

  const lastErrorMessage = lastError
    ? ` Last probe error: ${describeProbeError(lastError)}`
    : '';
  throw new Error(
    `Timed out waiting for OpenCode server readiness at ${baseUrl}.${lastErrorMessage}`,
  );
}
