import { DiscordApiForwardingError } from './api-forwarder';
import type { DiscordApiForwarder } from './api-forwarder';
import type { DiscordInboundQueue } from './inbound-queue';
import type { GatewayStatusStore } from './status';

const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

async function sleepUntilAborted(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPermanentForwardingError(error: unknown): boolean {
  return error instanceof DiscordApiForwardingError && !error.retryable;
}

const DELIVERY_INFRASTRUCTURE_STATUSES = new Set([
  401, 403, 404, 405, 408, 425, 429,
]);

/**
 * These failures describe the delivery path rather than one bad event. Keep
 * every stream entry and restart the worker so a secret rotation, deploy,
 * rate limit, timeout, or API outage cannot drain valid events into the DLQ.
 * Every 5xx counts: an unhandled exception or dependency blip surfaces as a
 * bare 500, and quarantining on it would silently discard valid traffic for
 * the whole incident.
 */
function isDeliveryInfrastructureError(error: unknown): boolean {
  if (!(error instanceof DiscordApiForwardingError)) return true;
  return (
    error.status >= 500 || DELIVERY_INFRASTRUCTURE_STATUSES.has(error.status)
  );
}

type DeliveryLoopParams = {
  queue: DiscordInboundQueue;
  forwarder: DiscordApiForwarder;
  status: GatewayStatusStore;
  signal: AbortSignal;
  pollMs: number;
  maxAttempts?: number;
  maxBackoffMs?: number;
};

export async function runDeliveryLoop(
  params: DeliveryLoopParams,
): Promise<void> {
  const maxAttempts = params.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxBackoffMs = params.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  let failureDelayMs = params.pollMs;

  while (!params.signal.aborted) {
    const entries = await params.queue.peek();
    if (entries.length === 0) {
      failureDelayMs = params.pollMs;
      await sleepUntilAborted(params.pollMs, params.signal);
      continue;
    }

    let retryableFailure = false;
    for (const entry of entries) {
      if (params.signal.aborted) return;

      if (entry.kind === 'malformed') {
        await params.queue.quarantine({
          streamId: entry.streamId,
          serializedEnvelope: entry.serializedEnvelope,
          reason: entry.reason,
          attempts: 0,
        });
        await params.status.update({
          queueDepth: await params.queue.depth(),
          lastError: `Quarantined malformed Discord event ${entry.streamId}: ${entry.reason}`,
        });
        continue;
      }

      const attempts = await params.queue.recordAttempt(entry.streamId);
      try {
        await params.forwarder.forward(entry.envelope);
        await params.queue.acknowledge(entry.streamId);
        await params.status.update({
          queueDepth: await params.queue.depth(),
          lastForwardedAt: new Date().toISOString(),
          lastError: undefined,
        });
      } catch (error) {
        if (isDeliveryInfrastructureError(error)) {
          throw error;
        }
        const permanent = isPermanentForwardingError(error);
        const attemptsExhausted = attempts >= maxAttempts;
        const reason = errorMessage(error);
        if (permanent || attemptsExhausted) {
          await params.queue.quarantine({
            streamId: entry.streamId,
            serializedEnvelope: entry.serializedEnvelope,
            reason: permanent
              ? `Permanent forwarding failure: ${reason}`
              : `Forwarding attempts exhausted: ${reason}`,
            attempts,
          });
          await params.status.update({
            queueDepth: await params.queue.depth(),
            lastError: `Quarantined Discord event ${entry.streamId} after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${reason}`,
          });
          continue;
        }

        retryableFailure = true;
        await params.status.update({
          queueDepth: await params.queue.depth(),
          lastError: reason,
        });
      }
    }

    if (retryableFailure) {
      await sleepUntilAborted(failureDelayMs, params.signal);
      failureDelayMs = Math.min(failureDelayMs * 2, maxBackoffMs);
    } else {
      failureDelayMs = params.pollMs;
    }
  }
}

type DeliveryLoop = (params: DeliveryLoopParams) => Promise<void>;

export async function runSupervisedDeliveryLoop(
  params: DeliveryLoopParams & {
    restartMaxBackoffMs?: number;
    runLoop?: DeliveryLoop;
  },
): Promise<void> {
  const runLoop = params.runLoop ?? runDeliveryLoop;
  const restartMaxBackoffMs =
    params.restartMaxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  let restartDelayMs = params.pollMs;

  while (!params.signal.aborted) {
    const startedAt = Date.now();
    try {
      // This flag represents a running delivery worker, not simply the
      // presence of an API secret. Any unexpected exit clears it first.
      await params.status.update({ forwardingReady: true });
      await runLoop(params);
      if (params.signal.aborted) break;
      throw new Error('Discord delivery loop exited unexpectedly');
    } catch (error) {
      if (params.signal.aborted) break;
      // A long healthy run means this failure is a fresh incident, not part
      // of the previous one — start the backoff over instead of ratcheting
      // toward the lifetime maximum.
      if (Date.now() - startedAt > restartMaxBackoffMs * 2) {
        restartDelayMs = params.pollMs;
      }
      await params.status
        .update({
          forwardingReady: false,
          lastError: `Discord delivery worker failed: ${errorMessage(error)}`,
        })
        .catch(() => undefined);
      await sleepUntilAborted(restartDelayMs, params.signal);
      restartDelayMs = Math.min(restartDelayMs * 2, restartMaxBackoffMs);
    }
  }

  await params.status.update({ forwardingReady: false }).catch(() => undefined);
}
