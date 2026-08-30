import { acquireRedisLock } from '@roomote/redis';
import type { FastAgentConversation } from './fast-agent-conversation';

const FAST_AGENT_TURN_LOCK_PREFIX = 'fast-agent:conversation-lock:';
const FAST_AGENT_TURN_LOCK_TTL_SECONDS = 600;
const FAST_AGENT_TURN_LOCK_RENEW_MS =
  (FAST_AGENT_TURN_LOCK_TTL_SECONDS * 1_000) / 3;
const FAST_AGENT_TURN_LOCK_RETRY_MS = 500;

export class FastAgentTurnLockLostError extends Error {
  constructor() {
    super('Fast conversation lock ownership was lost.');
    this.name = 'FastAgentTurnLockLostError';
  }
}

export type FastAgentTurnLockHandle = (() => Promise<void>) & {
  signal: AbortSignal;
  abort: (reason?: unknown) => Promise<void>;
};

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
  const key = buildFastAgentTurnLockKey(params.conversation);
  const maxAttempts =
    params.maxWaitMs === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(
          1,
          Math.ceil(params.maxWaitMs / FAST_AGENT_TURN_LOCK_RETRY_MS) + 1,
        );

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
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
        clearInterval(renewalTimer);
        await release();
      }) as FastAgentTurnLockHandle;
      releaseTurnLock.signal = ownership.signal;
      releaseTurnLock.abort = async (reason) => {
        ownership.abort(reason);
        await releaseTurnLock();
      };
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
