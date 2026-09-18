import type { Redis } from 'ioredis';

import { getRedis } from './client';

export const SESSION_PRESENCE_LEASE_MS = 30_000;
export const SESSION_BROWSER_ATTENTION_LEASE_MS = 30_000;

export type SessionBrowserNotificationPermission =
  | 'granted'
  | 'default'
  | 'denied'
  | 'unsupported';

type SessionPresenceIdentity = {
  sessionId: string;
  userId: string;
};

type SessionPresenceLease = SessionPresenceIdentity & {
  clientId: string;
};

type SessionVoiceCallLease = SessionPresenceLease & {
  generation: number;
};

type SessionPresenceOptions = {
  now?: number;
  redis?: Redis;
};

function sessionPresenceKey({ sessionId, userId }: SessionPresenceIdentity) {
  return `session:presence:${sessionId}:${userId}`;
}

function sessionVoiceCallKey({ sessionId, userId }: SessionPresenceIdentity) {
  return `session:voice:${sessionId}:${userId}`;
}

function sessionVoiceCallStateKey({
  sessionId,
  userId,
}: SessionPresenceIdentity) {
  return `session:voice-state:${sessionId}:${userId}`;
}

function sessionViewersKey(sessionId: string) {
  return `session:presence:viewers:${sessionId}`;
}

function sessionBrowserAttentionKey({
  sessionId,
  userId,
}: SessionPresenceIdentity) {
  return `session:browser-attention:${sessionId}:${userId}`;
}

async function refreshLease(
  lease: SessionPresenceLease,
  key: string,
  expiresAt: number,
  now: number,
  redis: Redis,
  index?: { key: string; member: string },
): Promise<void> {
  const transaction = redis
    .multi()
    .zadd(key, expiresAt, lease.clientId)
    .zremrangebyscore(key, '-inf', now)
    .pexpire(key, SESSION_PRESENCE_LEASE_MS * 2);
  if (index) {
    transaction
      .zadd(index.key, expiresAt, index.member)
      .zremrangebyscore(index.key, '-inf', now)
      .pexpire(index.key, SESSION_PRESENCE_LEASE_MS * 2);
  }
  await transaction.exec();
}

async function disconnectLease(
  lease: SessionPresenceLease,
  key: string,
  redis: Redis,
  index?: { key: string; member: string },
): Promise<void> {
  const transaction = redis.multi().zrem(key, lease.clientId);
  if (index) transaction.zrem(index.key, index.member);
  await transaction.exec();
}

async function isLeaseActive(
  identity: SessionPresenceIdentity,
  key: string,
  options: SessionPresenceOptions,
): Promise<boolean> {
  const now = options.now ?? Date.now();
  const redis = options.redis ?? getRedis();
  await redis.zremrangebyscore(key, '-inf', now);
  return (await redis.zcard(key)) > 0;
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

  await refreshLease(lease, key, expiresAt, now, redis, {
    key: viewersKey,
    member: `${lease.userId}:${lease.clientId}`,
  });

  return { expiresAt };
}

/** Best-effort immediate release; lease expiry remains the disconnect fallback. */
export async function disconnectSessionPresence(
  lease: SessionPresenceLease,
  options: Pick<SessionPresenceOptions, 'redis'> = {},
): Promise<void> {
  const redis = options.redis ?? getRedis();
  await disconnectLease(lease, sessionPresenceKey(lease), redis, {
    key: sessionViewersKey(lease.sessionId),
    member: `${lease.userId}:${lease.clientId}`,
  });
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
  return isLeaseActive(identity, sessionPresenceKey(identity), options);
}

/** Keeps one mounted Session/task page eligible for browser attention. */
export async function refreshSessionBrowserAttentionLease(
  lease: SessionPresenceLease & {
    permission: SessionBrowserNotificationPermission;
  },
  options: SessionPresenceOptions = {},
): Promise<{ expiresAt: number }> {
  const now = options.now ?? Date.now();
  const expiresAt = now + SESSION_BROWSER_ATTENTION_LEASE_MS;
  const redis = options.redis ?? getRedis();
  const key = sessionBrowserAttentionKey(lease);
  await redis
    .multi()
    .zadd(key, expiresAt, `${lease.clientId}:${lease.permission}`)
    .zremrangebyscore(key, '-inf', now)
    .pexpire(key, SESSION_BROWSER_ATTENTION_LEASE_MS * 2)
    .exec();
  return { expiresAt };
}

/** Best-effort release; expiry covers abrupt browser disconnects. */
export async function disconnectSessionBrowserAttentionLease(
  lease: SessionPresenceLease,
  options: Pick<SessionPresenceOptions, 'redis'> = {},
): Promise<void> {
  const redis = options.redis ?? getRedis();
  const key = sessionBrowserAttentionKey(lease);
  const members = await redis.zrange(key, 0, -1);
  const matching = members.filter((member) =>
    member.startsWith(`${lease.clientId}:`),
  );
  if (matching.length > 0) await redis.zrem(key, ...matching);
}

/** Returns notification capabilities for every unexpired mounted tab. */
export async function getSessionBrowserAttentionCapabilities(
  identity: SessionPresenceIdentity,
  options: SessionPresenceOptions = {},
): Promise<Record<SessionBrowserNotificationPermission, string[]>> {
  const now = options.now ?? Date.now();
  const redis = options.redis ?? getRedis();
  const key = sessionBrowserAttentionKey(identity);
  await redis.zremrangebyscore(key, '-inf', now);
  const members = await redis.zrangebyscore(key, `(${now}`, '+inf');
  const result: Record<SessionBrowserNotificationPermission, string[]> = {
    granted: [],
    default: [],
    denied: [],
    unsupported: [],
  };
  for (const member of members) {
    const separator = member.lastIndexOf(':');
    if (separator < 0) continue;
    const clientId = member.slice(0, separator);
    const permission = member.slice(separator + 1);
    if (permission in result) {
      result[permission as SessionBrowserNotificationPermission].push(clientId);
    }
  }
  return result;
}

/** Refreshes one browser tab's short-lived active voice-call lease. */
export async function refreshSessionVoiceCall(
  lease: SessionVoiceCallLease,
  options: SessionPresenceOptions = {},
): Promise<{ expiresAt: number }> {
  const now = options.now ?? Date.now();
  const expiresAt = now + SESSION_PRESENCE_LEASE_MS;
  const redis = options.redis ?? getRedis();
  const key = sessionVoiceCallKey(lease);
  const stateKey = sessionVoiceCallStateKey(lease);
  await redis
    .multi()
    .zadd(stateKey, 'GT', lease.generation, lease.clientId)
    .pexpire(stateKey, SESSION_PRESENCE_LEASE_MS * 2)
    .zadd(key, expiresAt, `${lease.clientId}:${lease.generation}`)
    .zremrangebyscore(key, '-inf', now)
    .pexpire(key, SESSION_PRESENCE_LEASE_MS * 2)
    .exec();
  return { expiresAt };
}

/** Best-effort immediate release; lease expiry covers abrupt disconnects. */
export async function disconnectSessionVoiceCall(
  lease: SessionVoiceCallLease,
  options: Pick<SessionPresenceOptions, 'redis'> = {},
): Promise<void> {
  const redis = options.redis ?? getRedis();
  const stateKey = sessionVoiceCallStateKey(lease);
  await redis
    .multi()
    .zadd(stateKey, 'GT', lease.generation, lease.clientId)
    .pexpire(stateKey, SESSION_PRESENCE_LEASE_MS * 2)
    .exec();
}

/** Returns whether the user has an unexpired voice-call lease for a Session. */
export async function isSessionVoiceCallActive(
  identity: SessionPresenceIdentity,
  options: SessionPresenceOptions = {},
): Promise<boolean> {
  const now = options.now ?? Date.now();
  const redis = options.redis ?? getRedis();
  const key = sessionVoiceCallKey(identity);
  await redis.zremrangebyscore(key, '-inf', now);
  const leases = await redis.zrangebyscore(key, `(${now}`, '+inf');
  const stateKey = sessionVoiceCallStateKey(identity);
  for (const lease of leases) {
    const separator = lease.lastIndexOf(':');
    if (separator < 0) continue;
    const clientId = lease.slice(0, separator);
    const generation = Number(lease.slice(separator + 1));
    if (!Number.isSafeInteger(generation)) continue;
    const currentGeneration = await redis.zscore(stateKey, clientId);
    if (
      currentGeneration !== null &&
      Number(currentGeneration) === generation
    ) {
      return true;
    }
  }
  return false;
}
