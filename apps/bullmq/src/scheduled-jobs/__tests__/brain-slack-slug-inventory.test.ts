import { beforeEach, describe, expect, it, vi } from 'vitest';

type FakeItem = { collectorId: string; itemId: string; slug: string };

const store = vi.hoisted(() => ({
  syncState: new Map<
    string,
    { backfillCursor: string | null; backfillCompletedAt: Date | null }
  >(),
  items: new Map<string, FakeItem>(),
  seeded: [] as Array<{ itemId: string; slug: string; lastSeenAt: Date }>,
  /** Each entry is one list_pages window answered in order. */
  listings: [] as Array<Array<{ slug: string }>>,
  listCalls: [] as Array<{ limit: number; offset: number }>,
  connection: { baseUrl: 'http://brain.test', token: 'read' } as {
    baseUrl: string;
    token: string;
  } | null,
}));

vi.mock('@roomote/sdk/server', () => ({
  resolveBrainConnection: vi.fn(async () => store.connection),
  callBrainTool: vi.fn(
    async (
      _connection: unknown,
      _tool: string,
      args: { limit: number; offset: number },
    ) => {
      store.listCalls.push(args);
      return [store.listings.shift() ?? []];
    },
  ),
  extractBrainCorpusPages: vi.fn((payloads: unknown[]) =>
    (payloads[0] as Array<{ slug: string }>).map((page) => ({
      slug: page.slug,
      title: null,
      updatedAt: null,
    })),
  ),
}));

vi.mock('@roomote/db/server', () => ({
  db: {},
  getBrainSyncState: vi.fn(async (_db: unknown, collectorId: string) => {
    const state = store.syncState.get(collectorId);
    return state
      ? {
          id: collectorId,
          collectorId,
          watermark: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...state,
        }
      : null;
  }),
  upsertBrainSyncState: vi.fn(
    async (
      _db: unknown,
      collectorId: string,
      patch: {
        backfillCursor?: string | null;
        backfillCompletedAt?: Date | null;
      },
    ) => {
      const existing = store.syncState.get(collectorId) ?? {
        backfillCursor: null,
        backfillCompletedAt: null,
      };
      store.syncState.set(collectorId, { ...existing, ...patch });
    },
  ),
  seedBrainCollectorItems: vi.fn(
    async (
      _db: unknown,
      collectorId: string,
      items: Array<{ itemId: string; slug: string; lastSeenAt: Date }>,
    ) => {
      for (const item of items) {
        store.seeded.push(item);
        if (!store.items.has(item.itemId)) {
          store.items.set(item.itemId, { collectorId, ...item });
        }
      }
    },
  ),
  listBrainCollectorItemsBySlugPrefix: vi.fn(
    async (_db: unknown, collectorId: string, prefix: string) =>
      [...store.items.values()]
        .filter(
          (item) =>
            item.collectorId === collectorId && item.itemId.startsWith(prefix),
        )
        .sort((a, b) => a.itemId.localeCompare(b.itemId)),
  ),
}));

const {
  SLACK_DAY_PAGE_ITEMS_ID,
  isSlackDayPageCensusComplete,
  parseSlackDayPageSlug,
  reconcileSlackDayPages,
  runSlackDayPageCensus,
} = await import('../brain-collectors/slack-day-page-inventory');

const CENSUS_STATE_ID = 'slack-public-channels:day-pages:census';

function daySlug(first: string, last: string, day = '2026-08-13') {
  const part = (iso: string) =>
    (Date.parse(iso) / 1000).toFixed(6).replace('.', '-');
  return `slack/T1/C1/${day}/${part(first)}-${part(last)}`;
}

function trackItem(slug: string) {
  store.items.set(slug, {
    collectorId: SLACK_DAY_PAGE_ITEMS_ID,
    itemId: slug,
    slug,
  });
}

function page(slug: string) {
  return { slug, title: 'day page', content: 'content' };
}

beforeEach(() => {
  store.syncState.clear();
  store.items.clear();
  store.seeded = [];
  store.listings = [];
  store.listCalls = [];
  store.connection = { baseUrl: 'http://brain.test', token: 'read' };
});

describe('parseSlackDayPageSlug', () => {
  it('parses the channel-day prefix and the embedded range', () => {
    const parsed = parseSlackDayPageSlug(
      'slack/T1/C1/2026-08-13/1755079500-123456-1755080400-000001',
    );

    expect(parsed).not.toBeNull();
    expect(parsed!.dayPrefix).toBe('slack/T1/C1/2026-08-13/');
    expect(parsed!.firstKey).toBe(1755079500123456);
    expect(parsed!.lastKey).toBe(1755080400000001);
  });

  it('rejects anything that is not a slack day page', () => {
    expect(parseSlackDayPageSlug('notion/abc123')).toBeNull();
    expect(parseSlackDayPageSlug('people/roomote-member-abc')).toBeNull();
    // Namespace without the day/range tail (e.g. a hypothetical index page).
    expect(parseSlackDayPageSlug('slack/T1/C1/2026-08-13')).toBeNull();
    expect(parseSlackDayPageSlug('slack/T1/C1/2026-08-13/summary')).toBeNull();
  });
});

describe('reconcileSlackDayPages', () => {
  it('tracks every emitted page and retires only fully covered chunks', async () => {
    const covered = daySlug('2026-08-13T10:10:00Z', '2026-08-13T10:50:00Z');
    const reachesOut = daySlug('2026-08-13T09:00:00Z', '2026-08-13T10:50:00Z');
    trackItem(covered);
    trackItem(reachesOut);

    const emitted = [
      page(daySlug('2026-08-13T10:00:00Z', '2026-08-13T11:00:00Z')),
    ];
    const result = await reconcileSlackDayPages({
      pages: emitted,
      now: new Date('2026-08-19T00:00:00Z'),
    });

    expect(result.itemUpdates).toEqual([
      {
        collectorId: SLACK_DAY_PAGE_ITEMS_ID,
        itemId: emitted[0]!.slug,
        slug: emitted[0]!.slug,
        lastSeenAt: new Date('2026-08-19T00:00:00Z'),
      },
    ]);
    expect(result.pageRetirements).toEqual([
      {
        collectorId: SLACK_DAY_PAGE_ITEMS_ID,
        itemId: covered,
        slug: covered,
      },
    ]);
  });

  it('unions coverage across the chunks of one day', async () => {
    // A busy day splits into several 200-message chunks; an old page inside
    // the union is superseded even though no single chunk contains it.
    const straddlesChunks = daySlug(
      '2026-08-13T10:30:00Z',
      '2026-08-13T11:30:00Z',
    );
    trackItem(straddlesChunks);

    const result = await reconcileSlackDayPages({
      pages: [
        page(daySlug('2026-08-13T10:00:00Z', '2026-08-13T11:00:00Z')),
        page(daySlug('2026-08-13T11:00:01Z', '2026-08-13T12:00:00Z')),
      ],
      now: new Date(),
    });

    expect(result.pageRetirements.map((r) => r.slug)).toEqual([
      straddlesChunks,
    ]);
  });

  it('never retires a page it just re-emitted', async () => {
    const unchanged = daySlug('2026-08-13T10:00:00Z', '2026-08-13T11:00:00Z');
    trackItem(unchanged);

    const result = await reconcileSlackDayPages({
      pages: [page(unchanged)],
      now: new Date(),
    });

    expect(result.pageRetirements).toEqual([]);
  });

  it('leaves tracked rows it cannot parse alone', async () => {
    // An inventory row from a future slug shape must not be deleted by an
    // older reader that cannot prove coverage.
    store.items.set('slack/T1/C1/2026-08-13/unparseable', {
      collectorId: SLACK_DAY_PAGE_ITEMS_ID,
      itemId: 'slack/T1/C1/2026-08-13/unparseable',
      slug: 'slack/T1/C1/2026-08-13/unparseable',
    });

    const result = await reconcileSlackDayPages({
      pages: [page(daySlug('2026-08-13T00:00:01Z', '2026-08-13T23:59:59Z'))],
      now: new Date(),
    });

    expect(result.pageRetirements).toEqual([]);
  });

  it('does nothing for an empty emission', async () => {
    trackItem(daySlug('2026-08-13T10:00:00Z', '2026-08-13T11:00:00Z'));

    const result = await reconcileSlackDayPages({ pages: [], now: new Date() });

    expect(result.itemUpdates).toEqual([]);
    expect(result.pageRetirements).toEqual([]);
  });
});

describe('runSlackDayPageCensus', () => {
  function listingOf(count: number, baseMinutes: number) {
    const base = Date.parse('2026-08-01T00:00:00Z') + baseMinutes * 60_000;
    return Array.from({ length: count }, (_, index) => ({
      slug: daySlug(
        new Date(base + index * 60_000).toISOString(),
        new Date(base + index * 60_000 + 30_000).toISOString(),
        '2026-08-01',
      ),
    }));
  }

  it('seeds only slack day pages and completes on a short window', async () => {
    store.listings = [
      [
        { slug: daySlug('2026-08-13T10:00:00Z', '2026-08-13T11:00:00Z') },
        { slug: 'notion/abc123' },
        { slug: 'people/roomote-member-abc' },
        { slug: 'slack/T1/C1/2026-08-13/summary' },
      ],
    ];

    await runSlackDayPageCensus();

    expect(store.seeded.map((item) => item.slug)).toEqual([
      daySlug('2026-08-13T10:00:00Z', '2026-08-13T11:00:00Z'),
    ]);
    expect(store.seeded[0]!.lastSeenAt).toEqual(new Date(0));
    expect(await isSlackDayPageCensusComplete()).toBe(true);
  });

  it('pages with offset and persists the cursor between windows', async () => {
    store.listings = [listingOf(100, 0), listingOf(37, 200)];

    await runSlackDayPageCensus();

    expect(store.listCalls.map((call) => call.offset)).toEqual([0, 100]);
    expect(store.seeded).toHaveLength(137);
    expect(store.syncState.get(CENSUS_STATE_ID)?.backfillCursor).toBeNull();
    expect(await isSlackDayPageCensusComplete()).toBe(true);
  });

  it('resumes from the persisted cursor after an interrupted run', async () => {
    store.syncState.set(CENSUS_STATE_ID, {
      backfillCursor: JSON.stringify({ offset: 200 }),
      backfillCompletedAt: null,
    });
    store.listings = [listingOf(10, 400)];

    await runSlackDayPageCensus();

    expect(store.listCalls.map((call) => call.offset)).toEqual([200]);
    expect(await isSlackDayPageCensusComplete()).toBe(true);
  });

  it('completes with a partial inventory when the listing ignores offset', async () => {
    const repeated = listingOf(100, 600);
    store.listings = [repeated, repeated];

    await runSlackDayPageCensus();

    // Two identical full windows: seeding is idempotent and the census
    // completes rather than walking the same window forever.
    expect(store.listCalls).toHaveLength(2);
    expect(store.items.size).toBe(100);
    expect(await isSlackDayPageCensusComplete()).toBe(true);
  });

  it('stays incomplete without a read connection', async () => {
    store.connection = null;

    await runSlackDayPageCensus();

    expect(store.listCalls).toHaveLength(0);
    expect(await isSlackDayPageCensusComplete()).toBe(false);
  });

  it('never lists again once complete', async () => {
    store.syncState.set(CENSUS_STATE_ID, {
      backfillCursor: null,
      backfillCompletedAt: new Date('2026-08-01T00:00:00Z'),
    });

    await runSlackDayPageCensus();

    expect(store.listCalls).toHaveLength(0);
  });
});
