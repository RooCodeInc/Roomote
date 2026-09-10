import { acquireRedisLock } from '@roomote/redis';
import type {
  FastAgentConversation,
  FastAgentTurnActivity,
} from './fast-agent-conversation';
import { releaseFastAgentDurableTurnClaim } from './fast-agent-conversation-repository';

const FAST_AGENT_TURN_LOCK_PREFIX = 'fast-agent:conversation-lock:';
const FAST_AGENT_TURN_LOCK_TTL_SECONDS = 600;
const FAST_AGENT_TURN_LOCK_RENEW_MS =
  (FAST_AGENT_TURN_LOCK_TTL_SECONDS * 1_000) / 3;
const FAST_AGENT_TURN_LOCK_RETRY_MS = 500;
const FAST_AGENT_ACTIVITY_CLEANUP_TIMEOUT_MS = 5_000;
type TurnActivityCleanup = Pick<FastAgentTurnActivity, 'settle' | 'dispose'>;
const turnActivityRegistrations = new WeakMap<
  AbortSignal,
  (activity: TurnActivityCleanup) => () => void
>();
const activeFastAgentTurnLocks = new Set<FastAgentTurnLockHandle>();
const shutdownCloseoutResolvers = new WeakMap<AbortSignal, () => void>();
const shutdownCloseoutPendingSignals = new WeakSet<AbortSignal>();
let processShutdownReason: FastAgentProcessShutdownError | null = null;

/** Bind one invocation's surface cleanup to its actual Redis lock, not inference completion. */
export function registerFastAgentTurnActivity(
  signal: AbortSignal,
  activity: TurnActivityCleanup,
): (() => void) | undefined {
  return turnActivityRegistrations.get(signal)?.(activity);
}

export class FastAgentTurnLockLostError extends Error {
  constructor() {
    super('Fast conversation lock ownership was lost.');
    this.name = 'FastAgentTurnLockLostError';
  }
}

/**
 * Abort reason for a Fast turn whose process is shutting down. Raised by
 * every process that executes turns (the API for the turns it admits, the
 * bullmq service for the turns the queue resumes).
 */
export class FastAgentProcessShutdownError extends Error {
  constructor(public readonly signal: NodeJS.Signals) {
    super(`Fast turn interrupted by process shutdown (${signal}).`);
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
      let turnSettlement: Promise<void> | undefined;
      let ownershipLost = false;
      let activity: TurnActivityCleanup | undefined;
      let redisReleasePromise: Promise<void> | undefined;
      const disposeActivity = (target = activity) => {
        try {
          void target?.dispose().catch((error) => {
            console.warn(
              '[Fast Agent] Failed to dispose surface activity:',
              error,
            );
          });
        } catch (error) {
          console.warn(
            '[Fast Agent] Failed to dispose surface activity:',
            error,
          );
        }
      };
      turnActivityRegistrations.set(ownership.signal, (next) => {
        if (ownership.signal.aborted || redisReleasePromise) {
          disposeActivity(next);
          return () => {};
        }
        activity = next;
        return () => {
          if (activity === next) activity = undefined;
        };
      });
      let renewalPending = false;
      const renewalTimer = setInterval(() => {
        if (renewalPending) return;
        renewalPending = true;
        void release
          .renewDetailed()
          .then((result) => {
            if (!redisReleased && result === 'lost') {
              ownershipLost = true;
              // Abort reasons are immutable: also fence loss discovered during an earlier abort.
              disposeActivity();
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

      const releaseRedisTurnLock = () => {
        redisReleasePromise ??= (async () => {
          const cleanup = activity;
          let deadline: ReturnType<typeof setTimeout> | undefined;
          try {
            if (cleanup) {
              await Promise.race([
                ownershipLost ? cleanup.dispose() : cleanup.settle(),
                new Promise<void>((resolve) => {
                  deadline = setTimeout(() => {
                    console.warn(
                      '[Fast Agent] Surface activity cleanup timed out before lock release.',
                    );
                    resolve();
                  }, FAST_AGENT_ACTIVITY_CLEANUP_TIMEOUT_MS);
                  deadline.unref();
                }),
              ]);
            }
          } catch (error) {
            console.warn(
              '[Fast Agent] Failed to settle surface activity before lock release:',
              error,
            );
          } finally {
            clearTimeout(deadline);
            // Fence even when draining timed out; never wait for stuck inference here.
            disposeActivity(cleanup);
            redisReleased = true;
            clearInterval(renewalTimer);
            await release();
          }
        })();
        return redisReleasePromise;
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
      const releaseTurnLock = (() => {
        turnSettlement ??= (async () => {
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
            activeFastAgentTurnLocks.delete(releaseTurnLock);
            notifyTurnSettleWaitersIfIdle();
          }
        })();
        return turnSettlement;
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
