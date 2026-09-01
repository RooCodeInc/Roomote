import type { Redis } from 'ioredis';

import { getRedis } from './client';

export const SESSION_PRESENCE_LEASE_MS = 30_000;

type SessionPresenceIdentity = {
  sessionId: string;
  userId: string;
};

type SessionPresenceLease = SessionPresenceIdentity & {
  clientId: string;
};

type SessionPresenceOptions = {
  now?: number;
  redis?: Redis;
};

function sessionPresenceKey({ sessionId, userId }: SessionPresenceIdentity) {
  return `session:presence:${sessionId}:${userId}`;
}

/** Refreshes one browser tab's short-lived presence lease. */
export async function refreshSessionPresence(
  lease: SessionPresenceLease,
  options: SessionPresenceOptions = {},
): Promise<{ expiresAt: number }> {
  const now = options.now ?? Date.now();
  const expiresAt = now + SESSION_PRESENCE_LEASE_MS;
  const redis = options.redis ?? getRedis();
  const key = sessionPresenceKey(lease);

  await redis
    .multi()
    .zadd(key, expiresAt, lease.clientId)
    .zremrangebyscore(key, '-inf', now)
    .pexpire(key, SESSION_PRESENCE_LEASE_MS * 2)
    .exec();

  return { expiresAt };
}

/** Best-effort immediate release; lease expiry remains the disconnect fallback. */
export async function disconnectSessionPresence(
  lease: SessionPresenceLease,
  options: Pick<SessionPresenceOptions, 'redis'> = {},
): Promise<void> {
  const redis = options.redis ?? getRedis();
  await redis.zrem(sessionPresenceKey(lease), lease.clientId);
}

/** Returns whether the user has any unexpired browser-tab lease for a Session. */
export async function isSessionUserPresent(
  identity: SessionPresenceIdentity,
  options: SessionPresenceOptions = {},
): Promise<boolean> {
  const now = options.now ?? Date.now();
  const redis = options.redis ?? getRedis();
  const key = sessionPresenceKey(identity);

  await redis.zremrangebyscore(key, '-inf', now);
  return (await redis.zcard(key)) > 0;
}
