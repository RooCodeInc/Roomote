import type { Redis } from 'ioredis';

import {
  disconnectSessionBrowserAttentionLease,
  disconnectSessionPresence,
  disconnectSessionVoiceCall,
  getSessionBrowserAttentionCapabilities,
  isSessionVoiceCallActive,
  isSessionUserPresent,
  listSessionPresentUserIds,
  refreshSessionPresence,
  refreshSessionBrowserAttentionLease,
  refreshSessionVoiceCall,
  SESSION_PRESENCE_LEASE_MS,
} from '../session-presence';

class PresenceRedis {
  private readonly sets = new Map<string, Map<string, number>>();

  multi() {
    const operations: Array<() => void> = [];
    const chain = {
      zadd: (
        key: string,
        scoreOrMode: number | 'GT',
        memberOrScore: string | number,
        maybeMember?: string,
      ) => {
        operations.push(() =>
          this.zadd(key, scoreOrMode, memberOrScore, maybeMember),
        );
        return chain;
      },
      zremrangebyscore: (key: string, min: string, max: number) => {
        operations.push(() => this.zremrangebyscore(key, min, max));
        return chain;
      },
      pexpire: () => chain,
      zrem: (key: string, member: string) => {
        operations.push(() => {
          void this.zrem(key, member);
        });
        return chain;
      },
      exec: async () => {
        operations.forEach((operation) => operation());
        return [];
      },
    };
    return chain;
  }

  zadd(
    key: string,
    scoreOrMode: number | 'GT',
    memberOrScore: string | number,
    maybeMember?: string,
  ) {
    const gt = scoreOrMode === 'GT';
    const score = gt ? Number(memberOrScore) : scoreOrMode;
    const member = gt ? maybeMember! : String(memberOrScore);
    const set = this.sets.get(key) ?? new Map<string, number>();
    if (gt && (set.get(member) ?? -Infinity) >= score) return 0;
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

  async zscore(key: string, member: string) {
    return this.sets.get(key)?.get(member)?.toString() ?? null;
  }

  async zrangebyscore(key: string, min: string, _max: string) {
    return [...(this.sets.get(key) ?? [])]
      .filter(([, score]) => score > Number(min.slice(1)))
      .map(([member]) => member);
  }

  async zrange(key: string, _start: number, _end: number) {
    return [...(this.sets.get(key)?.keys() ?? [])];
  }
}

const identity = { sessionId: 'session-1', userId: 'user-1' };

describe('Session presence leases', () => {
  let redis: Redis;

  beforeEach(() => {
    redis = new PresenceRedis() as unknown as Redis;
  });

  it('tracks mounted browser tabs separately by notification permission', async () => {
    await refreshSessionBrowserAttentionLease(
      {
        ...identity,
        clientId: 'tab-1',
        leaseId: 'lease-1',
        permission: 'granted',
      },
      { now: 1_000, redis },
    );
    await refreshSessionBrowserAttentionLease(
      {
        ...identity,
        clientId: 'tab-2',
        leaseId: 'lease-2',
        permission: 'default',
      },
      { now: 1_000, redis },
    );

    await expect(
      getSessionBrowserAttentionCapabilities(identity, { now: 2_000, redis }),
    ).resolves.toEqual({
      granted: ['tab-1'],
      default: ['tab-2'],
      denied: [],
      unsupported: [],
    });
    await expect(
      isSessionUserPresent(identity, { now: 2_000, redis }),
    ).resolves.toBe(false);
  });

  it('does not let replaced stream cleanup remove the replacement lease', async () => {
    await refreshSessionBrowserAttentionLease(
      {
        ...identity,
        clientId: 'tab-1',
        leaseId: 'lease-old',
        permission: 'default',
      },
      { now: 1_000, redis },
    );
    await refreshSessionBrowserAttentionLease(
      {
        ...identity,
        clientId: 'tab-1',
        leaseId: 'lease-new',
        permission: 'granted',
      },
      { now: 2_000, redis },
    );
    await disconnectSessionBrowserAttentionLease(
      {
        ...identity,
        clientId: 'tab-1',
        leaseId: 'lease-old',
        permission: 'default',
      },
      { redis },
    );
    expect(
      (
        await getSessionBrowserAttentionCapabilities(identity, {
          now: 2_000,
          redis,
        })
      ).granted,
    ).toEqual(['tab-1']);
    expect(
      (
        await getSessionBrowserAttentionCapabilities(identity, {
          now: 32_000,
          redis,
        })
      ).granted,
    ).toEqual([]);
  });

  it('lists distinct viewers across tabs and excludes expired leases at the deadline', async () => {
    await refreshSessionPresence(
      { ...identity, clientId: 'tab-1' },
      { now: 1_000, redis },
    );
    await refreshSessionPresence(
      { ...identity, clientId: 'tab-2' },
      { now: 2_000, redis },
    );
    await refreshSessionPresence(
      { ...identity, userId: 'user-2', clientId: 'tab-1' },
      { now: 1_000, redis },
    );
    await expect(
      listSessionPresentUserIds(identity.sessionId, { now: 2_000, redis }),
    ).resolves.toEqual(['user-1', 'user-2']);
    await expect(
      listSessionPresentUserIds(identity.sessionId, { now: 31_000, redis }),
    ).resolves.toEqual(['user-1']);
    await expect(
      listSessionPresentUserIds(identity.sessionId, { now: 32_000, redis }),
    ).resolves.toEqual([]);
  });

  it('refreshes indexed leases and isolates disconnects between tabs, users, and sessions', async () => {
    const lease = { ...identity, clientId: 'tab-1' };
    await refreshSessionPresence(lease, { now: 1_000, redis });
    await refreshSessionPresence(lease, { now: 20_000, redis });
    await refreshSessionPresence(
      { ...lease, clientId: 'tab-2' },
      { now: 20_000, redis },
    );
    await refreshSessionPresence(
      { ...lease, userId: 'user-2' },
      { now: 20_000, redis },
    );
    await refreshSessionPresence(
      { ...lease, sessionId: 'session-2' },
      { now: 20_000, redis },
    );
    await disconnectSessionPresence({ ...lease, clientId: 'tab-2' }, { redis });
    await expect(
      listSessionPresentUserIds(identity.sessionId, { now: 35_000, redis }),
    ).resolves.toEqual(['user-1', 'user-2']);
    await disconnectSessionPresence(lease, { redis });
    await expect(
      listSessionPresentUserIds(identity.sessionId, { now: 35_000, redis }),
    ).resolves.toEqual(['user-2']);
    await expect(
      listSessionPresentUserIds('session-2', { now: 35_000, redis }),
    ).resolves.toEqual(['user-1']);
    await expect(
      listSessionPresentUserIds('missing', { now: 35_000, redis }),
    ).resolves.toEqual([]);
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

describe('Session voice-call leases', () => {
  let redis: Redis;

  beforeEach(() => {
    redis = new PresenceRedis() as unknown as Redis;
  });

  it('refreshes, disconnects, and expires independently from view presence', async () => {
    const lease = { ...identity, clientId: 'tab-1' };
    await refreshSessionPresence(lease, { now: 1_000, redis });
    await refreshSessionVoiceCall(
      { ...lease, generation: 1 },
      { now: 2_000, redis },
    );

    await disconnectSessionPresence(lease, { redis });
    await expect(
      isSessionUserPresent(identity, { now: 2_000, redis }),
    ).resolves.toBe(false);
    await expect(
      isSessionVoiceCallActive(identity, { now: 2_000, redis }),
    ).resolves.toBe(true);
    await expect(
      isSessionVoiceCallActive(identity, {
        now: 2_000 + SESSION_PRESENCE_LEASE_MS,
        redis,
      }),
    ).resolves.toBe(false);

    await refreshSessionVoiceCall(
      { ...lease, generation: 2 },
      { now: 40_000, redis },
    );
    await disconnectSessionVoiceCall({ ...lease, generation: 3 }, { redis });
    await expect(
      isSessionVoiceCallActive(identity, { now: 40_000, redis }),
    ).resolves.toBe(false);
  });

  it('keeps a newer disconnect authoritative over a late heartbeat', async () => {
    const lease = { ...identity, clientId: 'tab-1' };
    await refreshSessionVoiceCall(
      { ...lease, generation: 1 },
      { now: 1_000, redis },
    );
    await disconnectSessionVoiceCall({ ...lease, generation: 2 }, { redis });
    await refreshSessionVoiceCall(
      { ...lease, generation: 1 },
      { now: 2_000, redis },
    );

    await expect(
      isSessionVoiceCallActive(identity, { now: 2_000, redis }),
    ).resolves.toBe(false);

    await refreshSessionVoiceCall(
      { ...lease, generation: 3 },
      { now: 3_000, redis },
    );
    await expect(
      isSessionVoiceCallActive(identity, { now: 3_000, redis }),
    ).resolves.toBe(true);
  });
});
