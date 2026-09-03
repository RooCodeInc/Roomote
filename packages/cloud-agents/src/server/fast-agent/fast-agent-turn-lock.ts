import { acquireRedisLock, getRedis } from '@roomote/redis';
import type { FastAgentConversation } from './fast-agent-conversation';
import {
  markFastAgentDurableTurnShutdown,
  releaseFastAgentDurableTurnClaim,
} from './fast-agent-conversation-repository';

const FAST_AGENT_TURN_LOCK_PREFIX = 'fast-agent:conversation-lock:';
const FAST_AGENT_TURN_LOCK_TTL_SECONDS = 600;
const FAST_AGENT_TURN_LOCK_RENEW_MS =
  (FAST_AGENT_TURN_LOCK_TTL_SECONDS * 1_000) / 3;
const FAST_AGENT_TURN_LOCK_RETRY_MS = 500;
const activeFastAgentTurnLocks = new Set<FastAgentTurnLockHandle>();
const shutdownCloseoutResolvers = new WeakMap<AbortSignal, () => void>();
const shutdownCloseoutPendingSignals = new WeakSet<AbortSignal>();
let processShutdownReason: FastAgentProcessShutdownError | null = null;
// The lock TTL the stop signal asked for, remembered so a row bound after the
// one-time stamp pass gets the same treatment.
let shutdownLockTtlSeconds: number | undefined;

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
  /** Wakes the queue for the bound row after a shutdown release so recovery
   * does not wait for the periodic sweep. Best effort. */
  durableResume?: () => Promise<void>;
  /**
   * Shorten this handle's Redis lock to the given TTL, only while this
   * handle still owns it (a successor's lock is never touched). Resolves
   * 'lost' when ownership is gone.
   */
  shortenLock?: (ttlSeconds: number) => Promise<'renewed' | 'lost' | 'error'>;
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

/**
 * Stamp every active durable turn with the stop signal, before any drain.
 * A process killed right after SIGTERM then still leaves evidence for the
 * dead-turn reconciler; a turn that finishes during the drain settles and
 * the stamp is moot. Best effort, never throws.
 */
export async function markActiveFastAgentTurnsShutdown(
  options: {
    /**
     * Shorten each bound turn's Redis lock to this many seconds. A process
     * killed after the stop signal never releases its locks, and the
     * dead-turn reconciler leaves a locked conversation alone, so without
     * this the closeout waits out the full lock TTL. Pass a value that
     * comfortably exceeds the drain window; a turn that finishes releases
     * the lock itself, and a live turn's renewal tick extends it again.
     */
    lockTtlSeconds?: number;
  } = {},
): Promise<number> {
  shutdownLockTtlSeconds = options.lockTtlSeconds;
  const bound = [...activeFastAgentTurnLocks].filter(
    (lock) => lock.durableRowId,
  );
  await Promise.allSettled(bound.map((lock) => stampTurnShutdown(lock)));
  return bound.length;
}

async function stampTurnShutdown(lock: FastAgentTurnLockHandle): Promise<void> {
  if (!lock.durableRowId) return;
  await markFastAgentDurableTurnShutdown(lock.durableRowId).catch((error) => {
    console.warn(
      `[Fast Agent] Failed to stamp a durable turn with the shutdown signal: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  if (shutdownLockTtlSeconds !== undefined && lock.shortenLock) {
    // Ownership-checked: a lock this process already lost belongs to a
    // successor and is left alone.
    await lock.shortenLock(shutdownLockTtlSeconds).catch((error) => {
      console.warn(
        `[Fast Agent] Failed to shorten a turn lock during shutdown: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
}

/**
 * Bind the inline-admitted durable row a turn executes to its lock. Every
 * accepting path binds through here so that a row bound after the stop
 * signal's one-time stamp pass (a worker between claiming its row and
 * binding it, say) is still stamped and its lock still shortened, instead of
 * dying unmarked and waiting out the lease.
 */
export async function bindFastAgentTurnLockDurableRow(
  lock: FastAgentTurnLockHandle,
  binding: { rowId: string; resume: () => Promise<void> },
): Promise<void> {
  lock.durableRowId = binding.rowId;
  lock.durableResume = binding.resume;
  if (processShutdownReason) await stampTurnShutdown(lock);
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
      .map(async (lock) => {
        const released = await releaseFastAgentDurableTurnClaim(
          lock.durableRowId!,
        ).catch((error) => {
          console.warn(
            `[Fast Agent] Failed to release durable turn claim during shutdown: ${error instanceof Error ? error.message : String(error)}`,
          );
          return false;
        });
        if (released) {
          await lock.durableResume?.().catch((error) => {
            console.warn(
              `[Fast Agent] Failed to wake durable turn resume during shutdown: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        }
      }),
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

/**
 * Whether some process currently holds the conversation's turn lock, i.e. a
 * turn (original or resumed) is still executing there. Used by reconcilers
 * to leave live turns alone however stale their durable rows look.
 */
export async function isFastAgentTurnLockHeld(
  conversation: FastAgentConversation,
): Promise<boolean> {
  return (await getRedis().exists(buildFastAgentTurnLockKey(conversation))) > 0;
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
      releaseTurnLock.shortenLock = async (ttlSeconds) =>
        redisReleased ? 'lost' : release.renewDetailed(ttlSeconds);
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
