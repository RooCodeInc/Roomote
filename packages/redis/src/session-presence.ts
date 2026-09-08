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

function sessionViewersKey(sessionId: string) {
  return `session:presence:viewers:${sessionId}`;
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
  const viewersKey = sessionViewersKey(lease.sessionId);

  await redis
    .multi()
    .zadd(key, expiresAt, lease.clientId)
    .zremrangebyscore(key, '-inf', now)
    .pexpire(key, SESSION_PRESENCE_LEASE_MS * 2)
    .zadd(viewersKey, expiresAt, `${lease.userId}:${lease.clientId}`)
    .zremrangebyscore(viewersKey, '-inf', now)
    .pexpire(viewersKey, SESSION_PRESENCE_LEASE_MS * 2)
    .exec();

  return { expiresAt };
}

/** Best-effort immediate release; lease expiry remains the disconnect fallback. */
export async function disconnectSessionPresence(
  lease: SessionPresenceLease,
  options: Pick<SessionPresenceOptions, 'redis'> = {},
): Promise<void> {
  const redis = options.redis ?? getRedis();
  await redis
    .multi()
    .zrem(sessionPresenceKey(lease), lease.clientId)
    .zrem(
      sessionViewersKey(lease.sessionId),
      `${lease.userId}:${lease.clientId}`,
    )
    .exec();
}

/** Lists distinct users with an unexpired tab lease, without scanning user keys. */
export async function listSessionPresentUserIds(
  sessionId: string,
  options: SessionPresenceOptions = {},
): Promise<string[]> {
  const now = options.now ?? Date.now();
  const redis = options.redis ?? getRedis();
  const members = await redis.zrangebyscore(
    sessionViewersKey(sessionId),
    `(${now}`,
    '+inf',
  );
  return [
    ...new Set(
      members.map((member) => member.slice(0, member.lastIndexOf(':'))),
    ),
  ];
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
