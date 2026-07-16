import type { Redis } from '@roomote/redis';

import {
  DISCORD_DEAD_LETTER_STREAM_KEY,
  DISCORD_INBOUND_ATTEMPTS_KEY,
  DISCORD_INBOUND_STREAM_KEY,
  DiscordInboundQueue,
  type DiscordInboundEnvelope,
} from './inbound-queue';

function mockRedis(overrides: Record<string, unknown> = {}): Redis {
  return {
    eval: vi.fn(),
    xrange: vi.fn(),
    hincrby: vi.fn(),
    hkeys: vi.fn().mockResolvedValue([]),
    hdel: vi.fn(),
    xlen: vi.fn(),
    ...overrides,
  } as unknown as Redis;
}

const envelope: DiscordInboundEnvelope = {
  eventId: 'message-1',
  eventType: 'MESSAGE_CREATE',
  payload: { id: 'message-1' },
  receivedAt: '2026-07-12T12:00:00.000Z',
};

describe('DiscordInboundQueue', () => {
  it('atomically deduplicates and appends an event', async () => {
    const redis = mockRedis({ eval: vi.fn().mockResolvedValue('1-0') });
    const queue = new DiscordInboundQueue(redis);

    await expect(queue.enqueue(envelope)).resolves.toBe(true);

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('XADD'"),
      2,
      'discord:gateway:dedupe:MESSAGE_CREATE:message-1',
      DISCORD_INBOUND_STREAM_KEY,
      '86400',
      JSON.stringify(envelope),
      '50000',
    );
    const enqueueScript = vi.mocked(redis.eval).mock.calls[0]?.[0] as string;
    // The durable stream is approximately bounded so a long delivery outage
    // cannot grow Redis without limit.
    expect(enqueueScript).toContain("'MAXLEN', '~', ARGV[3]");
    const script = vi.mocked(redis.eval).mock.calls[0]?.[0] as string;
    expect(script.indexOf("redis.call('XADD'")).toBeLessThan(
      script.indexOf("redis.call('SET'"),
    );
  });

  it('returns false for a duplicate event', async () => {
    const queue = new DiscordInboundQueue(
      mockRedis({ eval: vi.fn().mockResolvedValue(null) }),
    );

    await expect(queue.enqueue(envelope)).resolves.toBe(false);
  });

  it('reads and acknowledges durable stream entries', async () => {
    const redis = mockRedis({
      xrange: vi
        .fn()
        .mockResolvedValue([
          ['1710000000000-0', ['envelope', JSON.stringify(envelope)]],
        ]),
      xdel: vi.fn().mockResolvedValue(1),
    });
    const queue = new DiscordInboundQueue(redis);

    await expect(queue.peek()).resolves.toEqual([
      {
        kind: 'event',
        streamId: '1710000000000-0',
        envelope,
        serializedEnvelope: JSON.stringify(envelope),
      },
    ]);
    await queue.acknowledge('1710000000000-0');

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('XDEL'"),
      2,
      DISCORD_INBOUND_STREAM_KEY,
      DISCORD_INBOUND_ATTEMPTS_KEY,
      '1710000000000-0',
    );
  });

  it('returns malformed stream entries so the worker can quarantine them', async () => {
    const queue = new DiscordInboundQueue(
      mockRedis({
        xrange: vi.fn().mockResolvedValue([
          ['1-0', ['unexpected', 'value']],
          ['2-0', ['envelope', '{bad json']],
        ]),
      }),
    );

    await expect(queue.peek()).resolves.toEqual([
      expect.objectContaining({
        kind: 'malformed',
        streamId: '1-0',
        serializedEnvelope: '',
        reason: 'Stream entry is missing its envelope field',
      }),
      expect.objectContaining({
        kind: 'malformed',
        streamId: '2-0',
        serializedEnvelope: '{bad json',
      }),
    ]);
  });

  it('durably tracks attempts and atomically moves poison entries aside', async () => {
    const redis = mockRedis({
      hincrby: vi.fn().mockResolvedValue(3),
      eval: vi.fn().mockResolvedValue('dead-letter-1'),
    });
    const queue = new DiscordInboundQueue(redis);

    await expect(queue.recordAttempt('1-0')).resolves.toBe(3);
    expect(redis.hincrby).toHaveBeenCalledWith(
      DISCORD_INBOUND_ATTEMPTS_KEY,
      '1-0',
      1,
    );

    await expect(
      queue.quarantine({
        streamId: '1-0',
        serializedEnvelope: JSON.stringify(envelope),
        reason: 'Permanent API rejection',
        attempts: 3,
        quarantinedAt: new Date('2026-07-12T13:00:00.000Z'),
      }),
    ).resolves.toBe(true);
    expect(redis.eval).toHaveBeenLastCalledWith(
      expect.stringContaining("'XADD', KEYS[2]"),
      3,
      DISCORD_INBOUND_STREAM_KEY,
      DISCORD_DEAD_LETTER_STREAM_KEY,
      DISCORD_INBOUND_ATTEMPTS_KEY,
      '1-0',
      JSON.stringify(envelope),
      'Permanent API rejection',
      '3',
      '2026-07-12T13:00:00.000Z',
      '1000',
    );
  });

  it('prunes attempt counters for entries shed by the stream cap', async () => {
    const redis = mockRedis({
      // Oldest surviving entry is 200-0: 100-0 and 150-1 were shed by MAXLEN
      // without passing through acknowledge/quarantine.
      xrange: vi.fn().mockResolvedValue([['200-0', ['envelope', '{}']]]),
      hkeys: vi.fn().mockResolvedValue(['100-0', '150-1', '200-0', '250-0']),
      hdel: vi.fn().mockResolvedValue(2),
    });
    const queue = new DiscordInboundQueue(redis);

    await expect(queue.pruneOrphanedAttempts()).resolves.toBe(2);
    expect(redis.hdel).toHaveBeenCalledWith(
      DISCORD_INBOUND_ATTEMPTS_KEY,
      '100-0',
      '150-1',
    );
  });

  it('prunes every attempt counter when the stream is empty', async () => {
    const redis = mockRedis({
      xrange: vi.fn().mockResolvedValue([]),
      hkeys: vi.fn().mockResolvedValue(['100-0']),
      hdel: vi.fn().mockResolvedValue(1),
    });
    const queue = new DiscordInboundQueue(redis);

    await expect(queue.pruneOrphanedAttempts()).resolves.toBe(1);
    expect(redis.hdel).toHaveBeenCalledWith(
      DISCORD_INBOUND_ATTEMPTS_KEY,
      '100-0',
    );
  });

  it('never deletes a counter recorded after the snapshot (empty-stream race)', async () => {
    // Interleaving under test: HKEYS snapshots an empty hash, an event is
    // then enqueued and attempted, and XRANGE still observes the pre-enqueue
    // empty stream. The live counter is not in the snapshot, so it survives.
    const hkeys = vi.fn().mockResolvedValue([]);
    const xrange = vi.fn().mockResolvedValue([]);
    const hdel = vi.fn();
    const queue = new DiscordInboundQueue(mockRedis({ hkeys, xrange, hdel }));

    await expect(queue.pruneOrphanedAttempts()).resolves.toBe(0);
    expect(hkeys).toHaveBeenCalled();
    // Snapshot-first short-circuits: the stream is never even read, and no
    // deletion can touch a counter created after the snapshot.
    expect(xrange).not.toHaveBeenCalled();
    expect(hdel).not.toHaveBeenCalled();
  });

  it('snapshots tracked ids before reading the oldest stream entry', async () => {
    const order: string[] = [];
    const hkeys = vi.fn(async () => {
      order.push('hkeys');
      return ['100-0'];
    });
    const xrange = vi.fn(async () => {
      order.push('xrange');
      return [];
    });
    const hdel = vi.fn().mockResolvedValue(1);
    const queue = new DiscordInboundQueue(mockRedis({ hkeys, xrange, hdel }));

    await expect(queue.pruneOrphanedAttempts()).resolves.toBe(1);
    expect(order).toEqual(['hkeys', 'xrange']);
  });

  it('applies configured stream bounds and reports dead-letter depth', async () => {
    const redis = mockRedis({
      eval: vi.fn().mockResolvedValue('1-0'),
      xlen: vi.fn().mockResolvedValueOnce(42).mockResolvedValueOnce(7),
    });
    const queue = new DiscordInboundQueue(redis, {
      maxEntries: 500,
      deadLetterMaxEntries: 50,
    });

    expect(queue.capacity).toBe(500);
    await queue.enqueue(envelope);
    expect(vi.mocked(redis.eval).mock.calls[0]?.at(-1)).toBe('500');

    await expect(queue.depth()).resolves.toBe(42);
    await expect(queue.deadLetterDepth()).resolves.toBe(7);
    expect(redis.xlen).toHaveBeenLastCalledWith(DISCORD_DEAD_LETTER_STREAM_KEY);
  });
});
