import { acquireRedisLock } from '@roomote/redis';

const FAST_AGENT_TURN_LOCK_PREFIX = 'slack:fast-agent-lock:';
const FAST_AGENT_TURN_LOCK_TTL_SECONDS = 600;
const FAST_AGENT_TURN_LOCK_RETRY_MS = 500;
const FAST_AGENT_TURN_LOCK_MAX_ATTEMPTS =
  Math.ceil(
    (FAST_AGENT_TURN_LOCK_TTL_SECONDS * 1_000) / FAST_AGENT_TURN_LOCK_RETRY_MS,
  ) + 1;

/** Serialize every human and platform-generated Fast turn for one chat. */
export async function acquireFastAgentTurnLock(params: {
  slackTeamId: string;
  slackChannel: string;
  slackThreadTs: string;
  /** Cap the wait below the lock TTL so callers with their own retry or
   * user-feedback path can fail fast instead of blocking their context. */
  maxWaitMs?: number;
}) {
  const key = `${FAST_AGENT_TURN_LOCK_PREFIX}${params.slackTeamId}:${params.slackChannel}:${params.slackThreadTs}`;
  const maxAttempts =
    params.maxWaitMs === undefined
      ? FAST_AGENT_TURN_LOCK_MAX_ATTEMPTS
      : Math.max(
          1,
          Math.ceil(params.maxWaitMs / FAST_AGENT_TURN_LOCK_RETRY_MS) + 1,
        );

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const release = await acquireRedisLock(key, {
      ttlSeconds: FAST_AGENT_TURN_LOCK_TTL_SECONDS,
    });
    if (release) {
      return release;
    }

    if (attempt + 1 < maxAttempts) {
      await new Promise((resolve) =>
        setTimeout(resolve, FAST_AGENT_TURN_LOCK_RETRY_MS),
      );
    }
  }

  return null;
}
