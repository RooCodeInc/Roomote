import { acquireRedisLock } from '@roomote/redis';
import type { FastAgentConversation } from './fast-agent-conversation';

const FAST_AGENT_TURN_LOCK_PREFIX = 'fast-agent:conversation-lock:';
const FAST_AGENT_TURN_LOCK_TTL_SECONDS = 600;
const FAST_AGENT_TURN_LOCK_TTL_MS = FAST_AGENT_TURN_LOCK_TTL_SECONDS * 1_000;
const FAST_AGENT_TURN_LOCK_RENEW_MS = FAST_AGENT_TURN_LOCK_TTL_MS / 3;
const FAST_AGENT_TURN_LOCK_RETRY_MS = 500;

export class FastAgentTurnLockLostError extends Error {
  constructor(message = 'Fast conversation lock ownership was lost.') {
    super(message);
    this.name = 'FastAgentTurnLockLostError';
  }
}

export type FastAgentTurnLockHandle = (() => Promise<void>) & {
  signal: AbortSignal;
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
      const acquisitionConfirmedAt = Date.now();
      const ownership = new AbortController();
      let released = false;
      let renewalPending = false;
      let leaseDeadlineTimer: NodeJS.Timeout | undefined;
      const abortOwnership = (error: FastAgentTurnLockLostError) => {
        if (released || ownership.signal.aborted) return;
        ownership.abort(error);
        clearInterval(renewalTimer);
        if (leaseDeadlineTimer) clearTimeout(leaseDeadlineTimer);
        console.error(`[Fast Agent] ${error.message} Lock: ${key}`);
      };
      const scheduleLeaseDeadline = (confirmedAt: number) => {
        if (leaseDeadlineTimer) clearTimeout(leaseDeadlineTimer);
        const remainingMs =
          confirmedAt + FAST_AGENT_TURN_LOCK_TTL_MS - Date.now();
        if (remainingMs <= 0) {
          abortOwnership(
            new FastAgentTurnLockLostError(
              'Fast conversation lock renewal could not be confirmed before its lease deadline.',
            ),
          );
          return;
        }
        leaseDeadlineTimer = setTimeout(() => {
          abortOwnership(
            new FastAgentTurnLockLostError(
              'Fast conversation lock renewal could not be confirmed before its lease deadline.',
            ),
          );
        }, remainingMs);
        leaseDeadlineTimer.unref();
      };

      const renewalTimer = setInterval(() => {
        if (renewalPending) return;
        renewalPending = true;
        const renewalStartedAt = Date.now();
        void release
          .renewDetailed()
          .then((result) => {
            if (released || ownership.signal.aborted) return;
            if (result === 'renewed') {
              scheduleLeaseDeadline(renewalStartedAt);
            } else if (result === 'lost') {
              abortOwnership(new FastAgentTurnLockLostError());
            }
          })
          .finally(() => {
            renewalPending = false;
          });
      }, FAST_AGENT_TURN_LOCK_RENEW_MS);
      renewalTimer.unref();
      scheduleLeaseDeadline(acquisitionConfirmedAt);

      const releaseTurnLock = (async () => {
        released = true;
        clearInterval(renewalTimer);
        if (leaseDeadlineTimer) clearTimeout(leaseDeadlineTimer);
        await release();
      }) as FastAgentTurnLockHandle;
      releaseTurnLock.signal = ownership.signal;
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
