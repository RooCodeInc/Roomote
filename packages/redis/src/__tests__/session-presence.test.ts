import type { Redis } from 'ioredis';

import {
  disconnectSessionPresence,
  isSessionUserPresent,
  refreshSessionPresence,
  SESSION_PRESENCE_LEASE_MS,
} from '../session-presence';

class PresenceRedis {
  private readonly sets = new Map<string, Map<string, number>>();

  multi() {
    const operations: Array<() => void> = [];
    const chain = {
      zadd: (key: string, score: number, member: string) => {
        operations.push(() => this.zadd(key, score, member));
        return chain;
      },
      zremrangebyscore: (key: string, min: string, max: number) => {
        operations.push(() => this.zremrangebyscore(key, min, max));
        return chain;
      },
      pexpire: () => chain,
      exec: async () => {
        operations.forEach((operation) => operation());
        return [];
      },
    };
    return chain;
  }

  zadd(key: string, score: number, member: string) {
    const set = this.sets.get(key) ?? new Map<string, number>();
    set.set(member, score);
    this.sets.set(key, set);
    return 1;
  }

  async zrem(key: string, member: string) {
    return this.sets.get(key)?.delete(member) ? 1 : 0;
  }

  async zremrangebyscore(key: string, _min: string, max: number) {
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const [member, score] of set) {
      if (score <= max) {
        set.delete(member);
        removed += 1;
      }
    }
    return removed;
  }

  async zcard(key: string) {
    return this.sets.get(key)?.size ?? 0;
  }
}

const identity = { sessionId: 'session-1', userId: 'user-1' };

describe('Session presence leases', () => {
  let redis: Redis;

  beforeEach(() => {
    redis = new PresenceRedis() as unknown as Redis;
  });

  it('activates presence and expires it after the lease deadline', async () => {
    await refreshSessionPresence(
      { ...identity, clientId: 'tab-1' },
      { now: 1_000, redis },
    );

    await expect(
      isSessionUserPresent(identity, { now: 1_000, redis }),
    ).resolves.toBe(true);
    await expect(
      isSessionUserPresent(identity, {
        now: 1_000 + SESSION_PRESENCE_LEASE_MS,
        redis,
      }),
    ).resolves.toBe(false);
  });

  it('refreshes a tab lease from the latest heartbeat', async () => {
    await refreshSessionPresence(
      { ...identity, clientId: 'tab-1' },
      { now: 1_000, redis },
    );
    await refreshSessionPresence(
      { ...identity, clientId: 'tab-1' },
      { now: 20_000, redis },
    );

    await expect(
      isSessionUserPresent(identity, { now: 35_000, redis }),
    ).resolves.toBe(true);
    await expect(
      isSessionUserPresent(identity, { now: 50_000, redis }),
    ).resolves.toBe(false);
  });

  it('disconnects only the specified tab', async () => {
    await refreshSessionPresence(
      { ...identity, clientId: 'tab-1' },
      { now: 1_000, redis },
    );
    await refreshSessionPresence(
      { ...identity, clientId: 'tab-2' },
      { now: 1_000, redis },
    );

    await disconnectSessionPresence(
      { ...identity, clientId: 'tab-1' },
      { redis },
    );
    await expect(
      isSessionUserPresent(identity, { now: 1_000, redis }),
    ).resolves.toBe(true);

    await disconnectSessionPresence(
      { ...identity, clientId: 'tab-2' },
      { redis },
    );
    await expect(
      isSessionUserPresent(identity, { now: 1_000, redis }),
    ).resolves.toBe(false);
  });

  it('isolates leases between users and Sessions', async () => {
    await refreshSessionPresence(
      { ...identity, clientId: 'tab-1' },
      { now: 1_000, redis },
    );

    await expect(
      isSessionUserPresent(
        { sessionId: 'session-2', userId: identity.userId },
        { now: 1_000, redis },
      ),
    ).resolves.toBe(false);
    await expect(
      isSessionUserPresent(
        { sessionId: identity.sessionId, userId: 'user-2' },
        { now: 1_000, redis },
      ),
    ).resolves.toBe(false);
  });
});
