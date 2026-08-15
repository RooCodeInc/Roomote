import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getBrainSyncState, upsertBrainSyncState } from '@roomote/db/server';

import {
  buildGranolaMeetingPage,
  capSlackDayPagesForTick,
  groupSlackMessagesIntoDayPages,
  runBrainCollectors,
  type BrainCollector,
  type BrainSink,
  type CollectorPage,
  type SlackChannelMessage,
} from '../brain-collectors';
import { BrainRateLimitedError } from '../brain-outbox-drain';

type FakeSyncState = {
  watermark: Date | null;
  backfillCursor: string | null;
  backfillCompletedAt: Date | null;
};

/** In-memory stand-in for the durable brain_sync_state table. */
const syncStateStore = vi.hoisted(() => new Map<string, FakeSyncState>());

vi.mock('@roomote/db/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('@roomote/db/server')>();

  return {
    ...original,
    getBrainSyncState: vi.fn(async (_db: unknown, collectorId: string) => {
      const row = syncStateStore.get(collectorId);

      return row
        ? {
            id: 'test',
            collectorId,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...row,
          }
        : null;
    }),
    upsertBrainSyncState: vi.fn(
      async (
        _db: unknown,
        collectorId: string,
        patch: Partial<FakeSyncState>,
      ) => {
        const existing = syncStateStore.get(collectorId) ?? {
          watermark: null,
          backfillCursor: null,
          backfillCompletedAt: null,
        };

        syncStateStore.set(collectorId, { ...existing, ...patch });
      },
    ),
  };
});

const mockedUpsertSyncState = vi.mocked(upsertBrainSyncState);
const mockedGetSyncState = vi.mocked(getBrainSyncState);

beforeEach(() => {
  syncStateStore.clear();
  mockedUpsertSyncState.mockClear();
  mockedGetSyncState.mockClear();
});

const connection = { baseUrl: 'http://brain.test', token: 'test-token' };

function makePages(count: number, prefix = 'page'): CollectorPage[] {
  return Array.from({ length: count }, (_, index) => ({
    slug: `${prefix}/${index}`,
    title: `${prefix} ${index}`,
    content: `content ${index}`,
  }));
}

/** Unique ids per test: the engine watermark map is module-scoped. */
let collectorCounter = 0;
function uniqueId(label: string): string {
  collectorCounter += 1;
  return `test-${label}-${collectorCounter}`;
}

function makeCollector(overrides: Partial<BrainCollector>): BrainCollector {
  return {
    id: uniqueId('collector'),
    displayName: 'Test collector',
    isEnabled: async () => true,
    collect: async () => ({ pages: [], nextSince: null }),
    ...overrides,
  };
}

describe('runBrainCollectors', () => {
  it('advances the watermark between runs', async () => {
    const firstNextSince = new Date('2026-08-13T10:00:00Z');
    const collect = vi
      .fn<BrainCollector['collect']>()
      .mockResolvedValueOnce({ pages: makePages(1), nextSince: firstNextSince })
      .mockResolvedValueOnce({ pages: [], nextSince: null });
    const collector = makeCollector({ collect });
    const sink: BrainSink = vi.fn(async () => {});

    await runBrainCollectors(connection, {
      sink,
      collectors: [collector],
    });
    await runBrainCollectors(connection, {
      sink,
      collectors: [collector],
    });

    expect(collect).toHaveBeenCalledTimes(2);
    expect(collect.mock.calls[0]?.[0].since).toBeNull();
    expect(collect.mock.calls[1]?.[0].since).toEqual(firstNextSince);
    expect(mockedUpsertSyncState).toHaveBeenCalledWith(
      expect.anything(),
      collector.id,
      { watermark: firstNextSince },
    );
  });

  it('does not advance the watermark when the sink fails mid-batch', async () => {
    const collect = vi.fn<BrainCollector['collect']>().mockResolvedValue({
      pages: makePages(2),
      nextSince: new Date('2026-08-13T10:00:00Z'),
    });
    const collector = makeCollector({ collect });
    const sink: BrainSink = vi
      .fn(async () => {})
      .mockRejectedValueOnce(new Error('boom'));

    await runBrainCollectors(connection, {
      sink,
      collectors: [collector],
    });
    await runBrainCollectors(connection, {
      sink,
      collectors: [collector],
    });

    expect(collect.mock.calls[1]?.[0].since).toBeNull();
  });

  it('skips disabled collectors', async () => {
    const collect = vi.fn<BrainCollector['collect']>();
    const collector = makeCollector({ isEnabled: async () => false, collect });
    const sink: BrainSink = vi.fn(async () => {});

    await runBrainCollectors(connection, {
      sink,
      collectors: [collector],
    });

    expect(collect).not.toHaveBeenCalled();
  });

  it('caps pages per collector per tick', async () => {
    const collector = makeCollector({
      collect: async () => ({ pages: makePages(150), nextSince: null }),
    });
    const sink: BrainSink = vi.fn(async () => {});

    await runBrainCollectors(connection, {
      sink,
      collectors: [collector],
    });

    expect(sink).toHaveBeenCalledTimes(100);
  });

  it('ends the whole pass without throwing when the sink reports backpressure', async () => {
    const firstCollector = makeCollector({
      collect: async () => ({ pages: makePages(3), nextSince: null }),
    });
    const secondCollect = vi.fn<BrainCollector['collect']>();
    const secondCollector = makeCollector({ collect: secondCollect });
    const sink: BrainSink = vi.fn(async () => {
      throw new BrainRateLimitedError('gbrain put_page rate limited');
    });

    await expect(
      runBrainCollectors(connection, {
        sink,
        collectors: [firstCollector, secondCollector],
      }),
    ).resolves.toBeUndefined();

    expect(sink).toHaveBeenCalledTimes(1);
    expect(secondCollect).not.toHaveBeenCalled();
  });

  it('does not mistake page content mentioning 429 for backpressure', async () => {
    const firstCollector = makeCollector({
      collect: async () => ({ pages: makePages(1), nextSince: null }),
    });
    const secondCollect = vi
      .fn<BrainCollector['collect']>()
      .mockResolvedValue({ pages: [], nextSince: null });
    const secondCollector = makeCollector({ collect: secondCollect });
    const sink: BrainSink = vi.fn(async () => {
      throw new Error(
        'gbrain put_page failed: 500 {"text":"issue 429 rate_limit"}',
      );
    });

    await runBrainCollectors(connection, {
      sink,
      collectors: [firstCollector, secondCollector],
    });

    // A plain failure is one collector's problem, not a reason to stop.
    expect(secondCollect).toHaveBeenCalledTimes(1);
  });

  it('continues to the next collector after a non-429 collector error', async () => {
    const firstCollector = makeCollector({
      collect: async () => {
        throw new Error('upstream exploded');
      },
    });
    const secondCollect = vi
      .fn<BrainCollector['collect']>()
      .mockResolvedValue({ pages: makePages(1, 'second'), nextSince: null });
    const secondCollector = makeCollector({ collect: secondCollect });
    const sink: BrainSink = vi.fn(async () => {});

    await expect(
      runBrainCollectors(connection, {
        sink,
        collectors: [firstCollector, secondCollector],
      }),
    ).resolves.toBeUndefined();

    expect(secondCollect).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('redacts page content before it reaches the sink', async () => {
    const collector = makeCollector({
      collect: async () => ({
        pages: [
          {
            slug: 'slack/C123/2026-08-13',
            title: 'leaky page',
            content: 'token ghp_abcdefghijklmnopqrstuvwxyz012345 inside',
          },
        ],
        nextSince: null,
      }),
    });
    const sink = vi.fn<BrainSink>(async () => {});

    await runBrainCollectors(connection, {
      sink,
      collectors: [collector],
    });

    expect(sink.mock.calls[0]?.[0].content).toContain('[REDACTED]');
    expect(sink.mock.calls[0]?.[0].content).not.toContain('ghp_');
  });
});

describe('runBrainCollectors deep backfill', () => {
  it('runs the incremental phase first, then backfill, while backfill is incomplete', async () => {
    const collect = vi
      .fn<BrainCollector['collect']>()
      .mockResolvedValue({ pages: makePages(1, 'fresh'), nextSince: null });
    const backfill = vi
      .fn<NonNullable<BrainCollector['backfill']>>()
      .mockResolvedValue({
        pages: makePages(1, 'old'),
        nextCursor: null,
        done: true,
      });
    const collector = makeCollector({ collect, backfill });
    const sink: BrainSink = vi.fn(async () => {});

    await runBrainCollectors(connection, {
      sink,
      collectors: [collector],
    });

    expect(collect).toHaveBeenCalledTimes(1);
    expect(backfill).toHaveBeenCalledTimes(1);
    expect(collect.mock.invocationCallOrder[0]!).toBeLessThan(
      backfill.mock.invocationCallOrder[0]!,
    );
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it('respects the per-tick backfill page budget and persists each cursor', async () => {
    let step = 0;
    const backfill = vi
      .fn<NonNullable<BrainCollector['backfill']>>()
      .mockImplementation(async () => {
        step += 1;
        return {
          pages: makePages(50, `step${step}`),
          nextCursor: `c${step}`,
          done: false,
        };
      });
    const collector = makeCollector({ backfill });
    const sink: BrainSink = vi.fn(async () => {});

    await runBrainCollectors(connection, {
      sink,
      collectors: [collector],
    });

    // 2 steps of 50 pages exhaust the ~100-page budget.
    expect(backfill).toHaveBeenCalledTimes(2);
    expect(sink).toHaveBeenCalledTimes(100);
    expect(backfill.mock.calls[0]?.[0].cursor).toBeNull();
    expect(backfill.mock.calls[1]?.[0].cursor).toBe('c1');
    expect(syncStateStore.get(collector.id)?.backfillCursor).toBe('c2');
    expect(syncStateStore.get(collector.id)?.backfillCompletedAt).toBeNull();
  });

  it('keeps the last landed cursor when the sink 429s mid-backfill', async () => {
    const backfill = vi
      .fn<NonNullable<BrainCollector['backfill']>>()
      .mockResolvedValueOnce({
        pages: makePages(10, 'ok'),
        nextCursor: 'c1',
        done: false,
      })
      .mockResolvedValueOnce({
        pages: makePages(10, 'limited'),
        nextCursor: 'c2',
        done: false,
      });
    const collector = makeCollector({ backfill });
    let sinkCalls = 0;
    const sink: BrainSink = vi.fn(async () => {
      sinkCalls += 1;

      if (sinkCalls > 10) {
        throw new Error('gbrain put_page failed: 429 rate limited');
      }
    });

    await expect(
      runBrainCollectors(connection, {
        sink,
        collectors: [collector],
      }),
    ).resolves.toBeUndefined();

    // The first step's cursor landed; the failed second step's did not.
    expect(syncStateStore.get(collector.id)?.backfillCursor).toBe('c1');
    expect(syncStateStore.get(collector.id)?.backfillCompletedAt).toBeNull();
  });

  it('marks the backfill complete when a step reports done', async () => {
    const backfill = vi
      .fn<NonNullable<BrainCollector['backfill']>>()
      .mockResolvedValue({
        pages: makePages(3, 'tail'),
        nextCursor: null,
        done: true,
      });
    const collector = makeCollector({ backfill });
    const sink: BrainSink = vi.fn(async () => {});

    await runBrainCollectors(connection, {
      sink,
      collectors: [collector],
    });

    const state = syncStateStore.get(collector.id);
    expect(state?.backfillCompletedAt).toBeInstanceOf(Date);
    expect(state?.backfillCursor).toBeNull();
  });

  it('never runs backfill again after completion', async () => {
    const backfill = vi.fn<NonNullable<BrainCollector['backfill']>>();
    const collector = makeCollector({ backfill });

    syncStateStore.set(collector.id, {
      watermark: null,
      backfillCursor: null,
      backfillCompletedAt: new Date('2026-08-01T00:00:00Z'),
    });

    await runBrainCollectors(connection, {
      sink: vi.fn(async () => {}),
      collectors: [collector],
    });

    expect(backfill).not.toHaveBeenCalled();
  });

  it('resumes from the persisted cursor on the next pass', async () => {
    const backfill = vi
      .fn<NonNullable<BrainCollector['backfill']>>()
      .mockResolvedValue({ pages: [], nextCursor: 'resumed', done: false });
    const collector = makeCollector({ backfill });

    syncStateStore.set(collector.id, {
      watermark: null,
      backfillCursor: 'persisted-cursor',
      backfillCompletedAt: null,
    });

    await runBrainCollectors(connection, {
      sink: vi.fn(async () => {}),
      collectors: [collector],
    });

    expect(backfill.mock.calls[0]?.[0].cursor).toBe('persisted-cursor');
  });

  it('stops a stalled backfill (no pages, unchanged cursor) without marking done', async () => {
    const backfill = vi
      .fn<NonNullable<BrainCollector['backfill']>>()
      .mockResolvedValue({ pages: [], nextCursor: null, done: false });
    const collector = makeCollector({ backfill });

    await runBrainCollectors(connection, {
      sink: vi.fn(async () => {}),
      collectors: [collector],
    });

    expect(backfill).toHaveBeenCalledTimes(1);
    expect(syncStateStore.get(collector.id)?.backfillCompletedAt).toBeNull();
  });
});

describe('groupSlackMessagesIntoDayPages', () => {
  // 2026-08-13T14:03:20Z and 2026-08-14T09:10:00Z respectively.
  const day1Ts = String(Date.UTC(2026, 7, 13, 14, 3, 20) / 1000);
  const day1LaterTs = String(Date.UTC(2026, 7, 13, 15, 30, 0) / 1000);
  const day2Ts = String(Date.UTC(2026, 7, 14, 9, 10, 0) / 1000);

  it('groups messages into one page per channel per UTC day', () => {
    const messages: SlackChannelMessage[] = [
      {
        channelId: 'C1',
        channelName: 'general',
        ts: day1LaterTs,
        userId: 'U2',
        text: 'second message',
      },
      {
        channelId: 'C1',
        channelName: 'general',
        ts: day1Ts,
        userId: 'U1',
        text: 'first message',
      },
      {
        channelId: 'C1',
        channelName: 'general',
        ts: day2Ts,
        userId: 'U1',
        text: 'next day',
      },
      {
        channelId: 'C2',
        channelName: 'ops',
        ts: day1Ts,
        userId: null,
        text: 'ops message',
      },
    ];

    const pages = groupSlackMessagesIntoDayPages(messages);

    // Oldest day first, then channel name: a capped tick has to be able to
    // drop the newest pages and still report an honest watermark.
    expect(pages.map((page) => page.slug)).toEqual([
      'slack/C1/2026-08-13',
      'slack/C2/2026-08-13',
      'slack/C1/2026-08-14',
    ]);
    expect(pages[0]?.title).toBe('#general — 2026-08-13');
    expect(pages[0]?.content).toContain(
      'Slack public channel #general (C1), messages on 2026-08-13',
    );

    // Chronological order within the page despite reversed input order.
    const firstIndex = pages[0]?.content.indexOf('first message') ?? -1;
    const secondIndex = pages[0]?.content.indexOf('second message') ?? -1;
    expect(firstIndex).toBeGreaterThan(-1);
    expect(secondIndex).toBeGreaterThan(firstIndex);
    expect(pages[0]?.content).toContain('- [14:03] <U1>: first message');
    expect(pages[1]?.content).toContain('<unknown>: ops message');
  });

  it('drops empty and unparsable messages', () => {
    const pages = groupSlackMessagesIntoDayPages([
      {
        channelId: 'C1',
        channelName: 'general',
        ts: 'not-a-ts',
        userId: 'U1',
        text: 'bad ts',
      },
      {
        channelId: 'C1',
        channelName: 'general',
        ts: day1Ts,
        userId: 'U1',
        text: '   ',
      },
    ]);

    expect(pages).toEqual([]);
  });
});

describe('buildGranolaMeetingPage', () => {
  const fixture = {
    id: 'not_abc123def45678',
    title: 'Weekly Growth Sync',
    created_at: '2026-08-10T15:00:00Z',
    updated_at: '2026-08-10T16:30:00Z',
    attendees: [{ name: 'Matt' }, 'danny@example.com', { email: 'x@y.z' }],
    summary: 'Discussed the ops wedge. '.repeat(200),
  };

  it('maps a meeting note to a dated page', () => {
    const result = buildGranolaMeetingPage(fixture);

    expect(result).not.toBeNull();
    expect(result?.page.slug).toBe('meetings/2026-08-10-weekly-growth-sync');
    expect(result?.page.title).toBe('Weekly Growth Sync');
    expect(result?.updatedAt).toEqual(new Date('2026-08-10T16:30:00Z'));
    expect(result?.page.content).toContain('# Weekly Growth Sync');
    expect(result?.page.content).toContain('- Matt');
    expect(result?.page.content).toContain('- danny@example.com');
    expect(result?.page.content).toContain('- x@y.z');
    expect(result?.page.content).toContain(
      'granola_note_id: not_abc123def45678',
    );
  });

  it('caps the notes excerpt at 3000 characters', () => {
    const result = buildGranolaMeetingPage(fixture);
    const notesSection = result?.page.content.split('## Notes')[1] ?? '';

    expect(fixture.summary.length).toBeGreaterThan(3000);
    expect(notesSection.length).toBeLessThanOrEqual(3010);
  });

  it('falls back to the note id when the title is missing', () => {
    const result = buildGranolaMeetingPage({
      id: 'not_abc123def45678',
      created_at: '2026-08-10T15:00:00Z',
    });

    expect(result?.page.slug).toBe('meetings/2026-08-10-untitled-meeting');
    expect(result?.page.title).toBe('Untitled meeting');
  });

  it('returns null for unusable input instead of throwing', () => {
    expect(buildGranolaMeetingPage(null)).toBeNull();
    expect(buildGranolaMeetingPage(42)).toBeNull();
    expect(buildGranolaMeetingPage('string')).toBeNull();
    expect(buildGranolaMeetingPage({})).toBeNull();
  });
});

describe('capSlackDayPagesForTick', () => {
  const dayPage = (day: string, channel: string, hour: number) => ({
    day,
    maxTsMs: Date.UTC(2026, 7, Number(day.slice(-2)), hour),
    page: {
      slug: `slack/${channel}/${day}`,
      title: `#${channel} — ${day}`,
      content: 'x',
    },
  });

  it('reports the newest timestamp when nothing is capped', () => {
    const result = capSlackDayPagesForTick(
      [dayPage('2026-08-13', 'C1', 9), dayPage('2026-08-13', 'C2', 17)],
      10,
    );

    expect(result.pages).toHaveLength(2);
    expect(result.nextSince?.toISOString()).toBe('2026-08-13T17:00:00.000Z');
  });

  it('cuts on a day boundary so the watermark never passes a dropped page', () => {
    const dated = [
      dayPage('2026-08-13', 'C1', 9),
      dayPage('2026-08-13', 'C2', 17),
      dayPage('2026-08-14', 'C1', 10),
      dayPage('2026-08-14', 'C2', 11),
    ];

    // A limit of 3 would slice mid-way through 2026-08-14; the whole day has
    // to be deferred, or its dropped page would sit behind the watermark.
    const result = capSlackDayPagesForTick(dated, 3);

    expect(result.pages.map((page) => page.slug)).toEqual([
      'slack/C1/2026-08-13',
      'slack/C2/2026-08-13',
    ]);
    expect(result.nextSince?.toISOString()).toBe('2026-08-13T17:00:00.000Z');
  });

  it('refuses to advance when a single day exceeds the cap', () => {
    const dated = [
      dayPage('2026-08-13', 'C1', 9),
      dayPage('2026-08-13', 'C2', 10),
      dayPage('2026-08-13', 'C3', 11),
    ];

    const result = capSlackDayPagesForTick(dated, 2);

    expect(result.pages).toHaveLength(2);
    expect(result.nextSince).toBeNull();
  });
});

describe('backfill reaches channels joined later', () => {
  const cursorOf = (state: {
    completed: string[];
    key?: string | null;
    slackCursor?: string | null;
  }) => JSON.stringify({ key: null, slackCursor: null, ...state });

  it('keeps asking after every known channel is done, so a new one is picked up', async () => {
    // Reporting done would be permanent, and a bot added to a channel next
    // month would never have its history read.
    const backfill = vi
      .fn<NonNullable<BrainCollector['backfill']>>()
      // Everything known is already read: no pages, cursor unchanged.
      .mockResolvedValueOnce({
        pages: [],
        nextCursor: cursorOf({ completed: ['T1/C1'] }),
        done: false,
      });
    const collector = makeCollector({
      collect: async () => ({ pages: [], nextSince: null }),
      backfill,
    });

    await runBrainCollectors(connection, {
      sink: vi.fn(async () => {}),
      collectors: [collector],
    });

    // Never marked complete, so the next pass still runs.
    expect(mockedUpsertSyncState).not.toHaveBeenCalledWith(
      expect.anything(),
      collector.id,
      expect.objectContaining({ backfillCompletedAt: expect.anything() }),
    );
  });

  it('reads a channel that appears after earlier ones finished', async () => {
    const backfill = vi
      .fn<NonNullable<BrainCollector['backfill']>>()
      .mockResolvedValueOnce({
        pages: makePages(1, 'slack/C2'),
        nextCursor: cursorOf({ completed: ['T1/C1', 'T1/C2'] }),
        done: false,
      })
      .mockResolvedValueOnce({
        pages: [],
        nextCursor: cursorOf({ completed: ['T1/C1', 'T1/C2'] }),
        done: false,
      });
    const collector = makeCollector({
      collect: async () => ({ pages: [], nextSince: null }),
      backfill,
    });
    const sink = vi.fn(async () => {});

    await runBrainCollectors(connection, { sink, collectors: [collector] });

    // The new channel's history landed, and the pass stopped once the cursor
    // stopped moving rather than spinning on it.
    expect(sink).toHaveBeenCalledTimes(1);
    expect(backfill).toHaveBeenCalledTimes(2);
  });
});
