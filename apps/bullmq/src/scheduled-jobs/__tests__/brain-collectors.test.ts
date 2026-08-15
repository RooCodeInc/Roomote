import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getBrainSyncState, upsertBrainSyncState } from '@roomote/db/server';

import {
  buildGranolaMeetingPage,
  buildPersonIdentityLookup,
  buildPersonIdentityPage,
  buildSlackDirectoryPersonPage,
  groupSlackMessagesIntoDayPages,
  isSlackDirectoryRefreshDue,
  isSlackHumanProfile,
  runBrainCollectors,
  selectPersonIdentityBatch,
  slackDirectoryProfileFromApi,
  type BrainCollector,
  type BrainSink,
  type CollectorPage,
  type PersonIdentityRecord,
  type SlackDirectoryProfile,
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

  it('persists partition progress only after every page lands', async () => {
    const partitionWatermark = new Date('2026-08-13T11:00:00Z');
    const partitionCursor = '{"page":2}';
    const collector = makeCollector({
      collect: async () => ({
        pages: makePages(1),
        nextSince: null,
        stateUpdates: [
          {
            collectorId: 'test-collector:partition-a',
            watermark: partitionWatermark,
            cursor: partitionCursor,
          },
        ],
      }),
    });

    await runBrainCollectors(connection, {
      sink: vi.fn(async () => {}),
      collectors: [collector],
    });

    expect(syncStateStore.get('test-collector:partition-a')?.watermark).toEqual(
      partitionWatermark,
    );
    expect(
      syncStateStore.get('test-collector:partition-a')?.backfillCursor,
    ).toBe(partitionCursor);
  });

  it('can reset a dependent collector backfill after pages land', async () => {
    syncStateStore.set('granola-meetings', {
      watermark: new Date('2026-08-13T11:00:00Z'),
      backfillCursor: 'finished-cursor',
      backfillCompletedAt: new Date('2026-08-13T12:00:00Z'),
    });
    const collector = makeCollector({
      collect: async () => ({
        pages: makePages(1),
        nextSince: null,
        stateUpdates: [
          {
            collectorId: 'granola-meetings',
            cursor: null,
            backfillCompletedAt: null,
          },
        ],
      }),
    });

    await runBrainCollectors(connection, {
      sink: vi.fn(async () => {}),
      collectors: [collector],
    });

    expect(syncStateStore.get('granola-meetings')).toMatchObject({
      watermark: new Date('2026-08-13T11:00:00Z'),
      backfillCursor: null,
      backfillCompletedAt: null,
    });
  });

  it('holds partition watermarks when a page fails', async () => {
    const collector = makeCollector({
      collect: async () => ({
        pages: makePages(1),
        nextSince: null,
        stateUpdates: [
          {
            collectorId: 'test-collector:partition-a',
            watermark: new Date('2026-08-13T11:00:00Z'),
          },
        ],
      }),
    });

    await runBrainCollectors(connection, {
      sink: vi.fn(async () => {
        throw new Error('boom');
      }),
      collectors: [collector],
    });

    expect(syncStateStore.has('test-collector:partition-a')).toBe(false);
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

  it('caps pages per collector per pass', async () => {
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
    ).resolves.toEqual({ backfillProgressed: false, interrupted: true });

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
    ).resolves.toEqual({ backfillProgressed: false, interrupted: false });

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
  it('skips incremental upstream polling during historical continuation', async () => {
    const collect = vi.fn<BrainCollector['collect']>();
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
      includeIncremental: false,
    });

    expect(collect).not.toHaveBeenCalled();
    expect(backfill).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledTimes(1);
  });

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

  it('respects the per-pass backfill page budget and persists each cursor', async () => {
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

    const result = await runBrainCollectors(connection, {
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
    expect(result).toEqual({
      backfillProgressed: true,
      interrupted: false,
    });
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
    ).resolves.toEqual({ backfillProgressed: false, interrupted: false });

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

    const result = await runBrainCollectors(connection, {
      sink: vi.fn(async () => {}),
      collectors: [collector],
    });

    expect(backfill).toHaveBeenCalledTimes(1);
    expect(syncStateStore.get(collector.id)?.backfillCompletedAt).toBeNull();
    expect(result).toEqual({
      backfillProgressed: false,
      interrupted: false,
    });
  });
});

describe('groupSlackMessagesIntoDayPages', () => {
  // 2026-08-13T14:03:20Z and 2026-08-14T09:10:00Z respectively.
  const day1Ts = String(Date.UTC(2026, 7, 13, 14, 3, 20) / 1000);
  const day1LaterTs = String(Date.UTC(2026, 7, 13, 15, 30, 0) / 1000);
  const day2Ts = String(Date.UTC(2026, 7, 14, 9, 10, 0) / 1000);

  it('groups a batch into immutable channel/day chunks', () => {
    const messages: SlackChannelMessage[] = [
      {
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        ts: day1LaterTs,
        userId: 'U2',
        text: 'second message',
      },
      {
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        ts: day1Ts,
        userId: 'U1',
        userLabel: 'Alice Example',
        text: 'first message',
      },
      {
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        ts: day2Ts,
        userId: 'U1',
        text: 'next day',
      },
      {
        teamId: 'T1',
        channelId: 'C2',
        channelName: 'ops',
        ts: day1Ts,
        userId: null,
        text: 'ops message',
      },
    ];

    const pages = groupSlackMessagesIntoDayPages(messages);

    // Oldest day first, then workspace and channel for deterministic writes.
    expect(pages.map((page) => page.slug)).toEqual([
      `slack/T1/C1/2026-08-13/${day1Ts}-${day1LaterTs}`.replaceAll('.', '-'),
      `slack/T1/C2/2026-08-13/${day1Ts}-${day1Ts}`.replaceAll('.', '-'),
      `slack/T1/C1/2026-08-14/${day2Ts}-${day2Ts}`.replaceAll('.', '-'),
    ]);
    expect(pages[0]?.title).toBe('#general — 2026-08-13');
    expect(pages[0]?.content).toMatch(/^---\ndate: 2026-08-13\n---\n\n/);
    expect(pages[2]?.content).toMatch(/^---\ndate: 2026-08-14\n---\n\n/);
    expect(pages[0]?.content).toContain(
      'Slack public channel #general (C1), messages on 2026-08-13',
    );

    // Chronological order within the page despite reversed input order.
    const firstIndex = pages[0]?.content.indexOf('first message') ?? -1;
    const secondIndex = pages[0]?.content.indexOf('second message') ?? -1;
    expect(firstIndex).toBeGreaterThan(-1);
    expect(secondIndex).toBeGreaterThan(firstIndex);
    expect(pages[0]?.content).toContain(
      '- [14:03] <Alice Example (U1)>: first message',
    );
    expect(pages[1]?.content).toContain('<unknown>: ops message');
  });

  it('drops empty and unparsable messages', () => {
    const pages = groupSlackMessagesIntoDayPages([
      {
        teamId: 'T1',
        channelId: 'C1',
        channelName: 'general',
        ts: 'not-a-ts',
        userId: 'U1',
        text: 'bad ts',
      },
      {
        teamId: 'T1',
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
    expect(result?.page.slug).toBe(
      'meetings/2026-08-10-weekly-growth-sync-not-abc123def45678',
    );
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

    expect(result?.page.slug).toBe(
      'meetings/2026-08-10-untitled-meeting-not-abc123def45678',
    );
    expect(result?.page.title).toBe('Untitled meeting');
  });

  it('returns null for unusable input instead of throwing', () => {
    expect(buildGranolaMeetingPage(null)).toBeNull();
    expect(buildGranolaMeetingPage(42)).toBeNull();
    expect(buildGranolaMeetingPage('string')).toBeNull();
    expect(buildGranolaMeetingPage({})).toBeNull();
  });

  it('keeps same-day meetings with the same title distinct', () => {
    const first = buildGranolaMeetingPage({ ...fixture, id: 'note-1' });
    const second = buildGranolaMeetingPage({ ...fixture, id: 'note-2' });

    expect(first?.page.slug).not.toBe(second?.page.slug);
  });

  it('links known attendees to canonical person pages without exposing email', () => {
    const identities = new Map([
      [
        'danny@example.com',
        { slug: 'people/roomote-member-abc', title: 'Dan Riccio' },
      ],
    ]);
    const result = buildGranolaMeetingPage(fixture, identities);

    expect(result?.page.content).toContain(
      'attendees: ["people/roomote-member-abc"]',
    );
    expect(result?.page.content).toContain(
      '- [Dan Riccio](people/roomote-member-abc)',
    );
    expect(result?.page.content).not.toContain('- danny@example.com');
  });

  it('tries both attendee name and email before leaving a person unresolved', () => {
    const identities = new Map([
      [
        'dan@example.com',
        { slug: 'people/roomote-member-abc', title: 'Dan Riccio' },
      ],
    ]);
    const result = buildGranolaMeetingPage(
      {
        ...fixture,
        attendees: [{ name: 'Danny', email: 'dan@example.com' }],
      },
      identities,
    );

    expect(result?.page.content).toContain(
      '- [Dan Riccio](people/roomote-member-abc)',
    );
    expect(result?.page.content).not.toContain('dan@example.com');
  });
});

describe('person identity pages', () => {
  const record: PersonIdentityRecord = {
    userId: 'user-dan',
    name: 'Dan Riccio',
    email: 'dan@example.com',
    role: 'admin',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    deletedAt: null,
    providers: [
      {
        provider: 'Slack',
        identifier: 'U08TMEM25CP',
        display: 'Dan Riccio',
        title: 'VP of Engineering',
        updatedAt: new Date('2026-08-01T00:00:00Z'),
      },
      {
        provider: 'GitHub',
        identifier: 'daniel-lxs',
        updatedAt: new Date('2026-08-01T00:00:00Z'),
      },
    ],
  };

  it('creates a stable person card with provider aliases but no email', () => {
    const page = buildPersonIdentityPage(record);
    const renamed = buildPersonIdentityPage({
      ...record,
      name: 'Daniel Riccio',
    });

    expect(page.slug).toBe(renamed.slug);
    expect(page.slug).toMatch(/^people\/roomote-member-[a-f0-9]{16}$/);
    expect(page.title).toBe('Dan Riccio');
    expect(page.content).toContain('type: person');
    expect(page.content).toContain('daniel-lxs');
    expect(page.content).toContain('U08TMEM25CP');
    expect(page.content).toContain(
      '- Slack: Dan Riccio (U08TMEM25CP) — VP of Engineering',
    );
    expect(page.content).toContain('Joined Roomote on 2026-01-01.');
    expect(page.content).not.toContain('dan@example.com');
  });

  it('scrubs embedded emails from names and provider values', () => {
    const page = buildPersonIdentityPage({
      ...record,
      name: 'Dan Riccio <dan@example.com>',
      providers: [
        ...record.providers,
        {
          provider: 'Source control',
          identifier: 'daniel-lxs <provider@example.com>',
          display: 'Dan R. (display@example.com)',
          updatedAt: record.updatedAt,
        },
      ],
    });

    expect(page.title).toBe('Dan Riccio');
    expect(page.content).toContain('Dan R. (daniel-lxs)');
    expect(page.content).not.toContain('@example.com');
  });

  it('uses email only as a private attendee-resolution hint', () => {
    const lookup = buildPersonIdentityLookup([record]);

    expect(lookup.get('dan riccio')).toEqual(
      expect.objectContaining({ title: 'Dan Riccio' }),
    );
    expect(lookup.get('daniel-lxs')).toEqual(
      expect.objectContaining({ title: 'Dan Riccio' }),
    );
    expect(lookup.get('dan@example.com')).toEqual(
      expect.objectContaining({ title: 'Dan Riccio' }),
    );
  });

  it('removes provider aliases when a member is deleted', () => {
    const page = buildPersonIdentityPage({
      ...record,
      deletedAt: new Date('2026-08-15T00:00:00Z'),
    });

    expect(page.content).toContain('status: deleted');
    expect(page.content).toContain('aliases: []');
    expect(page.content).not.toContain('U08TMEM25CP');
    expect(page.content).not.toContain('daniel-lxs');
  });

  it('normalizes Slack directory profiles and excludes bots and app users', () => {
    const profile = slackDirectoryProfileFromApi({
      teamId: 'TROOMOTE',
      teamName: 'Roomote',
      user: {
        id: 'UADA',
        name: 'ada',
        real_name: 'Ada Lovelace',
        updated: 1_786_817_600,
        profile: { display_name: 'Ada', title: 'Mathematician' },
      },
    });

    expect(profile).toMatchObject({
      displayName: 'Ada',
      realName: 'Ada Lovelace',
      title: 'Mathematician',
    });
    expect(profile && isSlackHumanProfile(profile, 'UROOMOTE')).toBe(true);
    expect(
      profile && isSlackHumanProfile({ ...profile, isBot: true }, 'UROOMOTE'),
    ).toBe(false);
    expect(
      profile &&
        isSlackHumanProfile({ ...profile, isAppUser: true }, 'UROOMOTE'),
    ).toBe(false);
  });

  it('refreshes a newly connected Slack workspace immediately', () => {
    const now = new Date('2026-08-15T12:00:00Z');

    expect(isSlackDirectoryRefreshDue({ state: null, now })).toBe(true);
    expect(
      isSlackDirectoryRefreshDue({
        state: {
          watermark: new Date('2026-08-15T11:00:00Z'),
          backfillCursor: null,
        },
        now,
      }),
    ).toBe(false);
    expect(
      isSlackDirectoryRefreshDue({
        state: {
          watermark: new Date('2026-08-15T11:00:00Z'),
          backfillCursor: 'next-page',
        },
        now,
      }),
    ).toBe(true);
  });

  it('builds standalone person cards for Slack members without Roomote accounts', () => {
    const profile: SlackDirectoryProfile = {
      slackUserId: 'UADA',
      slackTeamId: 'TROOMOTE',
      slackTeamName: 'Roomote',
      username: 'ada',
      displayName: 'Ada',
      realName: 'Ada Lovelace',
      title: 'Mathematician',
      isDeleted: false,
      isBot: false,
      isAppUser: false,
      profileUpdatedAt: new Date('2026-08-15T00:00:00Z'),
    };
    const page = buildSlackDirectoryPersonPage(profile);

    expect(page.slug).toMatch(/^people\/slack-member-[a-f0-9]{16}$/);
    expect(page.title).toBe('Ada');
    expect(page.content).toContain('type: person');
    expect(page.content).toContain('Title: Mathematician');
    expect(page.content).toContain('- Slack: ada (UADA)');
  });

  it('turns a mapped Slack profile into an alias of its canonical Roomote card', () => {
    const page = buildSlackDirectoryPersonPage(
      {
        slackUserId: 'U08TMEM25CP',
        slackTeamId: 'TROOMOTE',
        slackTeamName: 'Roomote',
        username: 'dan',
        displayName: 'Dan Riccio',
        realName: 'Daniel Riccio',
        title: 'VP of Engineering',
        isDeleted: false,
        isBot: false,
        isAppUser: false,
        profileUpdatedAt: new Date('2026-08-15T00:00:00Z'),
      },
      { slug: 'people/roomote-member-abc', title: 'Dan Riccio' },
    );

    expect(page.content).toContain('type: person-alias');
    expect(page.content).toContain('canonical: "people/roomote-member-abc"');
    expect(page.content).toContain('[Dan Riccio](people/roomote-member-abc)');
  });

  it('paginates full reconciliation sweeps without timestamp gaps', () => {
    const second = { ...record, userId: 'user-zed', name: 'Zed Example' };
    const firstBatch = selectPersonIdentityBatch({
      records: [second, record],
      state: null,
      now: new Date('2026-08-15T00:00:00Z'),
      limit: 1,
    });
    const secondBatch = selectPersonIdentityBatch({
      records: [second, record],
      state: {
        watermark: firstBatch.watermark,
        cursor: firstBatch.cursor,
      },
      now: new Date('2026-08-15T00:01:00Z'),
      limit: 1,
    });

    expect(firstBatch.records.map(({ userId }) => userId)).toEqual([
      'user-dan',
    ]);
    expect(firstBatch.projectionChanged).toBe(true);
    expect(secondBatch.records.map(({ userId }) => userId)).toEqual([
      'user-zed',
    ]);
    expect(secondBatch.projectionChanged).toBe(false);
    expect(JSON.parse(secondBatch.cursor)).toMatchObject({ mode: 'idle' });
  });

  it('detects identity projection changes independently of page pagination', () => {
    const initial = selectPersonIdentityBatch({
      records: [record],
      state: null,
      now: new Date('2026-08-15T00:00:00Z'),
      limit: 100,
    });
    const changed = selectPersonIdentityBatch({
      records: [
        {
          ...record,
          providers: [
            ...record.providers,
            {
              provider: 'GitHub',
              identifier: 'dan-renamed',
              updatedAt: new Date('2026-08-15T00:01:00Z'),
            },
          ],
        },
      ],
      state: { watermark: initial.watermark, cursor: initial.cursor },
      now: new Date('2026-08-15T00:02:00Z'),
      limit: 100,
    });

    expect(changed.projectionChanged).toBe(true);
  });

  it('refreshes canonical cards when a provider projection changes with an old timestamp', () => {
    const initial = selectPersonIdentityBatch({
      records: [record],
      state: null,
      now: new Date('2026-08-15T00:00:00Z'),
      limit: 100,
    });
    const changedRecord = {
      ...record,
      providers: record.providers.map((provider) =>
        provider.provider === 'Slack'
          ? { ...provider, title: 'Chief Analogy Officer' }
          : provider,
      ),
    };
    const changed = selectPersonIdentityBatch({
      records: [changedRecord],
      state: { watermark: initial.watermark, cursor: initial.cursor },
      now: new Date('2026-08-15T00:01:00Z'),
      limit: 100,
    });

    expect(changed.projectionChanged).toBe(true);
    expect(changed.records).toEqual([changedRecord]);
    expect(buildPersonIdentityPage(changed.records[0]!).content).toContain(
      'Chief Analogy Officer',
    );
  });

  it('restarts an active sweep when an earlier provider projection changes', () => {
    const second = { ...record, userId: 'user-zed', name: 'Zed Example' };
    const firstBatch = selectPersonIdentityBatch({
      records: [second, record],
      state: null,
      now: new Date('2026-08-15T00:00:00Z'),
      limit: 1,
    });
    const changedRecord = {
      ...record,
      providers: record.providers.map((provider) =>
        provider.provider === 'Slack'
          ? { ...provider, title: 'Chief Analogy Officer' }
          : provider,
      ),
    };
    const restarted = selectPersonIdentityBatch({
      records: [second, changedRecord],
      state: { watermark: firstBatch.watermark, cursor: firstBatch.cursor },
      now: new Date('2026-08-15T00:01:00Z'),
      limit: 1,
    });

    expect(restarted.projectionChanged).toBe(true);
    expect(restarted.records).toEqual([changedRecord]);
  });

  it('periodically reconciles mapping removals and late timestamp ties', () => {
    const staleCursor = JSON.stringify({
      mode: 'incremental',
      lastSweepAt: '2026-08-13T00:00:00Z',
      afterUpdatedAt: record.updatedAt.toISOString(),
      afterUserId: 'user-zed',
    });
    const recordWithoutProviders = { ...record, providers: [] };
    const batch = selectPersonIdentityBatch({
      records: [recordWithoutProviders],
      state: {
        watermark: record.updatedAt,
        cursor: staleCursor,
      },
      now: new Date('2026-08-15T00:00:00Z'),
      limit: 100,
    });

    expect(batch.records).toEqual([recordWithoutProviders]);
    expect(buildPersonIdentityPage(batch.records[0]!).content).not.toContain(
      'daniel-lxs',
    );
    expect(JSON.parse(batch.cursor)).toMatchObject({ mode: 'idle' });
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
      .mockResolvedValue({
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
