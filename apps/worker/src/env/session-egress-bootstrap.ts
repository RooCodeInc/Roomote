import { setTimeout } from 'node:timers/promises';

/** Waits for server-authenticated, controller-verified admission, not a local flag. */
export async function waitForSessionEgressDelivery(
  read: () => Promise<{ environment: Record<string, string> | null }>,
  signal: AbortSignal,
): Promise<Record<string, string>> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const { environment } = await read();
    if (environment) return environment;
    await setTimeout(500, undefined, { signal });
  }
  throw new Error('Session egress admission timed out');
}
