import { acquireRedisLock } from '@roomote/redis';
import type { FastAgentConversation } from './fast-agent-conversation';

const FAST_AGENT_TURN_LOCK_PREFIX = 'fast-agent:conversation-lock:';
const FAST_AGENT_TURN_LOCK_TTL_SECONDS = 600;
const FAST_AGENT_TURN_LOCK_RENEW_MS =
  (FAST_AGENT_TURN_LOCK_TTL_SECONDS * 1_000) / 3;
const FAST_AGENT_TURN_LOCK_RETRY_MS = 500;
const activeFastAgentTurnLocks = new Set<FastAgentTurnLockHandle>();
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
};

export async function abortActiveFastAgentTurns(
  reason: FastAgentProcessShutdownError,
): Promise<number> {
  processShutdownReason ??= reason;
  const activeLocks = [...activeFastAgentTurnLocks];
  await Promise.allSettled(
    activeLocks.map((lock) => lock.abort(processShutdownReason!)),
  );
  return activeLocks.length;
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
      let released = false;
      let renewalPending = false;
      const renewalTimer = setInterval(() => {
        if (renewalPending) return;
        renewalPending = true;
        void release
          .renewDetailed()
          .then((result) => {
            if (!released && result === 'lost') {
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

      const releaseTurnLock = (async () => {
        if (released) return;
        released = true;
        activeFastAgentTurnLocks.delete(releaseTurnLock);
        clearInterval(renewalTimer);
        await release();
      }) as FastAgentTurnLockHandle;
      releaseTurnLock.signal = ownership.signal;
      releaseTurnLock.abort = async (reason) => {
        ownership.abort(reason);
        await releaseTurnLock();
      };
      activeFastAgentTurnLocks.add(releaseTurnLock);
      if (processShutdownReason) {
        await releaseTurnLock.abort(processShutdownReason);
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
