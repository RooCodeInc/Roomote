import { acquireRedisLock } from '@roomote/redis';
import type { FastAgentConversation } from './fast-agent-conversation';
import { releaseFastAgentDurableTurnClaim } from './fast-agent-conversation-repository';

const FAST_AGENT_TURN_LOCK_PREFIX = 'fast-agent:conversation-lock:';
const FAST_AGENT_TURN_LOCK_TTL_SECONDS = 600;
const FAST_AGENT_TURN_LOCK_RENEW_MS =
  (FAST_AGENT_TURN_LOCK_TTL_SECONDS * 1_000) / 3;
const FAST_AGENT_TURN_LOCK_RETRY_MS = 500;
const activeFastAgentTurnLocks = new Set<FastAgentTurnLockHandle>();
const shutdownCloseoutResolvers = new WeakMap<AbortSignal, () => void>();
const shutdownCloseoutPendingSignals = new WeakSet<AbortSignal>();
let processShutdownReason: FastAgentProcessShutdownError | null = null;

export class FastAgentTurnLockLostError extends Error {
  constructor() {
    super('Fast conversation lock ownership was lost.');
    this.name = 'FastAgentTurnLockLostError';
  }
}

export class FastAgentProcessShutdownError extends Error {
  constructor(signal: NodeJS.Signals) {
    super(`Fast turn interrupted by API shutdown (${signal}).`);
    this.name = 'FastAgentProcessShutdownError';
  }
}

export type FastAgentTurnLockHandle = (() => Promise<void>) & {
  signal: AbortSignal;
  abort: (reason?: unknown) => Promise<void>;
  abortForShutdown: (reason: FastAgentProcessShutdownError) => Promise<void>;
  /** Resolves after shutdown closeout delivery settles, without waiting for
   * unrelated inference cleanup that may itself be stuck. */
  shutdownCloseoutSettled: Promise<void>;
  /**
   * The inline-admitted durable row this turn executes, when durable
   * admission applied. Bound by the accepting handler so a shutdown can
   * release the row's claim even if the turn is interrupted before it
   * reaches its own abort handling (for example during setup).
   */
  durableRowId?: string;
};

/** Mark the user-visible shutdown closeout as posted and persisted (or as
 * attempted when the provider rejects delivery). */
export function markFastAgentShutdownCloseoutSettled(
  signal: AbortSignal,
): void {
  shutdownCloseoutResolvers.get(signal)?.();
}

/** Mark that an accepted turn has entered answer handling and can deliver the
 * user-visible shutdown closeout. */
export function markFastAgentShutdownCloseoutPending(
  signal: AbortSignal,
): void {
  if (!signal.aborted && shutdownCloseoutResolvers.has(signal)) {
    shutdownCloseoutPendingSignals.add(signal);
  }
}

export async function abortActiveFastAgentTurns(
  reason: FastAgentProcessShutdownError,
): Promise<number> {
  processShutdownReason ??= reason;
  const activeLocks = [...activeFastAgentTurnLocks];
  await Promise.allSettled(
    activeLocks.map((lock) => lock.abortForShutdown(processShutdownReason!)),
  );
  // A turn interrupted before it reached its own abort handling (still in
  // setup, no inference yet) never releases its durable claim, and the row
  // would wait out the full claim lease before recovery. Release here for
  // every bound row; the release is a guarded no-op for rows the turn
  // already revoked or settled, so replay safety is unaffected.
  await Promise.allSettled(
    activeLocks
      .filter((lock) => lock.durableRowId)
      .map((lock) =>
        releaseFastAgentDurableTurnClaim(lock.durableRowId!).catch((error) => {
          console.warn(
            `[Fast Agent] Failed to release durable turn claim during shutdown: ${error instanceof Error ? error.message : String(error)}`,
          );
        }),
      ),
  );
  return activeLocks.length;
}

const turnSettleWaiters = new Set<() => void>();

function notifyTurnSettleWaitersIfIdle() {
  if (activeFastAgentTurnLocks.size > 0) return;
  for (const waiter of [...turnSettleWaiters]) waiter();
}

/**
 * Refuse new Fast turn admissions without aborting the active ones, so a
 * shutdown can let in-flight turns finish before interrupting the remainder.
 */
export function beginFastAgentTurnDrain(
  reason: FastAgentProcessShutdownError,
): void {
  processShutdownReason ??= reason;
}

/**
 * Resolve once every active Fast turn has settled or the deadline passes.
 * Returns the number of turns still active at that point.
 */
export async function waitForActiveFastAgentTurnsToSettle(
  timeoutMs: number,
): Promise<number> {
  if (timeoutMs > 0 && activeFastAgentTurnLocks.size > 0) {
    await new Promise<void>((resolve) => {
      const settle = () => {
        clearTimeout(deadline);
        turnSettleWaiters.delete(settle);
        resolve();
      };
      turnSettleWaiters.add(settle);
      const deadline = setTimeout(settle, timeoutMs);
      deadline.unref();
    });
  }
  return activeFastAgentTurnLocks.size;
}

/** Serialize every human and platform-generated Fast turn for one chat. */
export function buildFastAgentTurnLockKey(
  conversation: FastAgentConversation,
): string {
  return `${FAST_AGENT_TURN_LOCK_PREFIX}${conversation.surface}:${conversation.workspaceId}:${conversation.conversationId}`;
}

export async function acquireFastAgentTurnLock(params: {
  conversation: FastAgentConversation;
  /** Cap the wait below the lock TTL so callers with their own retry or
   * user-feedback path can fail fast instead of blocking their context. */
  maxWaitMs?: number;
}) {
  if (processShutdownReason) return null;

  const key = buildFastAgentTurnLockKey(params.conversation);
  const maxAttempts =
    params.maxWaitMs === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(
          1,
          Math.ceil(params.maxWaitMs / FAST_AGENT_TURN_LOCK_RETRY_MS) + 1,
        );

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (processShutdownReason) return null;
    const release = await acquireRedisLock(key, {
      ttlSeconds: FAST_AGENT_TURN_LOCK_TTL_SECONDS,
    });
    if (release) {
      const ownership = new AbortController();
      let redisReleased = false;
      let turnSettled = false;
      let renewalPending = false;
      const renewalTimer = setInterval(() => {
        if (renewalPending) return;
        renewalPending = true;
        void release
          .renewDetailed()
          .then((result) => {
            if (!redisReleased && result === 'lost') {
              ownership.abort(new FastAgentTurnLockLostError());
              clearInterval(renewalTimer);
              console.error(
                `[Fast Agent] Conversation lock ownership was lost for ${key}.`,
              );
            }
          })
          .finally(() => {
            renewalPending = false;
          });
      }, FAST_AGENT_TURN_LOCK_RENEW_MS);
      renewalTimer.unref();

      const releaseRedisTurnLock = async () => {
        if (redisReleased) return;
        redisReleased = true;
        clearInterval(renewalTimer);
        await release();
      };
      let shutdownCloseoutSettled = false;
      let resolveShutdownCloseout: (() => void) | undefined;
      const shutdownCloseoutPromise = new Promise<void>((resolve) => {
        resolveShutdownCloseout = resolve;
      });
      const settleShutdownCloseout = () => {
        if (shutdownCloseoutSettled) return;
        shutdownCloseoutSettled = true;
        shutdownCloseoutPendingSignals.delete(ownership.signal);
        shutdownCloseoutResolvers.delete(ownership.signal);
        resolveShutdownCloseout?.();
      };
      shutdownCloseoutResolvers.set(ownership.signal, settleShutdownCloseout);
      const releaseTurnLock = (async () => {
        if (turnSettled) return;
        turnSettled = true;
        activeFastAgentTurnLocks.delete(releaseTurnLock);
        notifyTurnSettleWaitersIfIdle();
        try {
          if (
            ownership.signal.reason instanceof FastAgentProcessShutdownError
          ) {
            settleShutdownCloseout();
            await shutdownCloseoutPromise;
          }
          await releaseRedisTurnLock();
        } finally {
          settleShutdownCloseout();
        }
      }) as FastAgentTurnLockHandle;
      releaseTurnLock.signal = ownership.signal;
      releaseTurnLock.abort = async (reason) => {
        ownership.abort(reason);
        await releaseRedisTurnLock();
      };
      releaseTurnLock.abortForShutdown = async (reason) => {
        ownership.abort(reason);
        if (
          ownership.signal.reason instanceof FastAgentProcessShutdownError &&
          shutdownCloseoutPendingSignals.has(ownership.signal)
        ) {
          await shutdownCloseoutPromise;
        }
        await releaseRedisTurnLock();
      };
      releaseTurnLock.shutdownCloseoutSettled = shutdownCloseoutPromise;
      activeFastAgentTurnLocks.add(releaseTurnLock);
      if (processShutdownReason) {
        ownership.abort(processShutdownReason);
        await releaseTurnLock();
        return null;
      }
      return releaseTurnLock;
    }

    if (attempt + 1 < maxAttempts) {
      await new Promise((resolve) =>
        setTimeout(resolve, FAST_AGENT_TURN_LOCK_RETRY_MS),
      );
    }
  }

  return null;
}
