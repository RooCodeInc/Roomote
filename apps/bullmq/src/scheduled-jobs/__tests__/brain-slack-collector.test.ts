/**
 * The Slack collector against a fake Slack.
 *
 * Every other test here mocks `collect()` at the collector boundary, which
 * means the function where this collector's bugs actually live never runs.
 * All of them have been interactions rather than single mistakes: a page
 * ceiling meeting a time window, a day-boundary cap meeting a watermark, an
 * error path meeting an advance. Each limit was correct alone and tested
 * alone, which is exactly why the tests kept passing.
 *
 * So this drives the real collector against a Slack that behaves like the
 * real one (newest-first, oldest/latest filtering, cursor paging), and asserts
 * a property over many ticks rather than a scenario: everything posted inside
 * the window is ingested exactly once, and the watermark keeps moving. A new
 * limit that conflicts with an existing one breaks that property without
 * anyone having to predict the conflict.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type FakeMessage = { ts: string; text: string; user: string };
type FakeChannel = { id: string; name: string; messages: FakeMessage[] };
type FakeItem = { collectorId: string; itemId: string; slug: string };

const workspace = vi.hoisted(() => ({
  channels: [] as FakeChannel[],
  /** Channel ids whose next history read throws, to exercise failure paths. */
  failing: new Set<string>(),
  historyCalls: 0,
  syncState: new Map<
    string,
    { watermark: Date | null; backfillCompletedAt?: Date | null }
  >(),
  brainPages: new Map<string, string>(),
  /** The day-page inventory, as the engine would persist it. */
  items: new Map<string, FakeItem>(),
  retired: [] as string[],
}));

// The inventory module reaches for gbrain reads only in the census, which
// these tests bypass by seeding its sync state as complete.
vi.mock('@roomote/sdk/server', () => ({
  callBrainTool: vi.fn(async () => []),
  extractBrainCorpusPages: vi.fn(() => []),
  resolveBrainConnection: vi.fn(async () => null),
}));

vi.mock('@roomote/db/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('@roomote/db/server')>();

  return {
    ...original,
    getBrainSyncState: vi.fn(async (_db: unknown, collectorId: string) => {
      const state = workspace.syncState.get(collectorId);

      return state
        ? {
            id: collectorId,
            collectorId,
            watermark: state.watermark,
            backfillCursor: null,
            backfillCompletedAt: state.backfillCompletedAt ?? null,
            createdAt: new Date(),
            updatedAt: new Date(),
          }
        : null;
    }),
    listBrainCollectorItemsBySlugPrefix: vi.fn(
      async (_db: unknown, collectorId: string, prefix: string) =>
        [...workspace.items.values()]
          .filter(
            (item) =>
              item.collectorId === collectorId &&
              item.itemId.startsWith(prefix),
          )
          .sort((a, b) => a.itemId.localeCompare(b.itemId)),
    ),
    db: {
      select: () => ({
        from: () => ({
          where: async () => [
            { teamId: 'T1', botAccessToken: 'xoxb-test', isActive: true },
          ],
        }),
      }),
      query: {
        slackInstallations: { findFirst: async () => ({ id: 'i1' }) },
        slackUserMappings: {
          findMany: async () => [
            {
              slackTeamId: 'T1',
              slackUserId: 'U1',
              user: {
                id: 'alice-user-id',
                name: 'Alice Example <alice@example.com>',
                createdAt: new Date('2026-01-01T00:00:00Z'),
                deletedAt: null,
              },
            },
          ],
        },
        mcpConnections: { findFirst: async () => null },
      },
    },
  };
});

vi.mock('@roomote/slack', () => ({
  createSlackWebClient: () => ({
    conversations: {
      list: async () => ({
        channels: workspace.channels.map((c) => ({
          id: c.id,
          name: c.name,
          is_member: true,
          is_private: false,
        })),
      }),
      /**
       * Slack's real contract, which is what makes this worth having:
       * results are newest-first, `oldest`/`latest` bound the range, `limit`
       * truncates, and `next_cursor` walks toward older messages.
       */
      history: async ({
        channel,
        limit,
        oldest,
        latest,
        cursor,
      }: {
        channel: string;
        limit: number;
        oldest?: string;
        latest?: string;
        cursor?: string;
      }) => {
        workspace.historyCalls++;

        if (workspace.failing.has(channel)) {
          throw new Error('slack is having a moment');
        }

        const found = workspace.channels.find((c) => c.id === channel);
        const inRange = (found?.messages ?? [])
          .filter((m) => {
            const ts = Number(m.ts);
            return (
              (!oldest || ts > Number(oldest)) &&
              (!latest || ts <= Number(latest))
            );
          })
          .sort((a, b) => Number(b.ts) - Number(a.ts));

        const start = cursor ? Number(cursor) : 0;
        const page = inRange.slice(start, start + limit);
        const nextStart = start + limit;

        return {
          messages: page,
          response_metadata:
            nextStart < inRange.length
              ? { next_cursor: String(nextStart) }
              : {},
        };
      },
    },
  }),
}));

const { slackPublicChannelsCollector } =
  await import('../brain-collectors/slack-public-channels');
const { SLACK_DAY_PAGE_ITEMS_ID } =
  await import('../brain-collectors/slack-day-page-inventory');

const DAY_MS = 24 * 60 * 60 * 1000;
const CENSUS_STATE_ID = 'slack-public-channels:day-pages:census';
const slackStateId = (channelId: string) =>
  `${slackPublicChannelsCollector.id}:T1/${channelId}`;

/** Seed a page as the pre-tracking era left it: in the Brain and (as the
 * census would record it) in the inventory, with a batch-timestamp slug. */
function seedLegacyPage(slug: string, content = 'legacy content') {
  workspace.brainPages.set(slug, content);
  workspace.items.set(slug, {
    collectorId: SLACK_DAY_PAGE_ITEMS_ID,
    itemId: slug,
    slug,
  });
}

function legacyChunkSlug(
  channelId: string,
  day: string,
  firstIso: string,
  lastIso: string,
) {
  const part = (iso: string) =>
    (Date.parse(iso) / 1000).toFixed(6).replace('.', '-');
  // Lowercase like the corpus stores it (and like the census seeds it),
  // even though the fake Slack's team/channel ids are uppercase.
  return `slack/T1/${channelId}/${day}/${part(firstIso)}-${part(lastIso)}`.toLowerCase();
}

function seedChannel(
  id: string,
  name: string,
  count: number,
  spanMs: number,
  endMs: number,
): FakeChannel {
  const messages: FakeMessage[] = [];

  for (let i = 0; i < count; i++) {
    // Spread evenly across the span, oldest first.
    const at = endMs - spanMs + Math.floor((spanMs * i) / Math.max(count, 1));
    messages.push({
      ts: (at / 1000).toFixed(6),
      text: `${id} message ${i}`,
      user: 'U1',
    });
  }

  return { id, name, messages };
}

/**
 * Apply a successful engine write in the engine's order: pages land first,
 * then retirements soft-delete superseded pages and drop their inventory
 * rows, then fresh inventory rows persist, then every independent source
 * watermark advances.
 */
function applyResult(result: {
  pages: Array<{ slug: string; content: string }>;
  stateUpdates?: Array<{ collectorId: string; watermark?: Date }>;
  itemUpdates?: Array<{ collectorId: string; itemId: string; slug: string }>;
  pageRetirements?: Array<{ itemId: string; slug: string }>;
}) {
  for (const page of result.pages) {
    workspace.brainPages.set(page.slug, page.content);
  }

  for (const retirement of result.pageRetirements ?? []) {
    workspace.brainPages.delete(retirement.slug);
    workspace.items.delete(retirement.itemId);
    workspace.retired.push(retirement.slug);
  }

  for (const update of result.itemUpdates ?? []) {
    workspace.items.set(update.itemId, {
      collectorId: update.collectorId,
      itemId: update.itemId,
      slug: update.slug,
    });
  }

  for (const update of result.stateUpdates ?? []) {
    if (!update.watermark) continue;
    workspace.syncState.set(update.collectorId, {
      watermark: update.watermark,
    });
  }
}

function ingestedMessages(): Set<string> {
  const ingested = new Set<string>();

  for (const content of workspace.brainPages.values()) {
    for (const line of content.split('\n')) {
      const match = line.match(/: (C\d+ message \d+)$/);
      if (match?.[1]) ingested.add(match[1]);
    }
  }

  return ingested;
}

/** Run repeated engine-like ticks until no channel watermark moves. */
async function drainToCaughtUp(from: Date | null = null, maxTicks = 60) {
  if (from) {
    for (const channel of workspace.channels) {
      const stateId = slackStateId(channel.id);
      if (!workspace.syncState.has(stateId)) {
        workspace.syncState.set(stateId, { watermark: from });
      }
    }
  }

  let ticks = 0;

  for (; ticks < maxTicks; ticks++) {
    const before = new Map(
      [...workspace.syncState].map(([key, state]) => [
        key,
        state.watermark?.getTime() ?? null,
      ]),
    );
    const result = await slackPublicChannelsCollector.collect({
      since: null,
      now: new Date(),
      limit: 100,
    });
    applyResult(result);

    const moved = [...workspace.syncState].some(
      ([key, state]) =>
        before.get(key) !== (state.watermark?.getTime() ?? null),
    );
    if (!moved) break;
  }

  return {
    ingested: ingestedMessages(),
    // Channel watermarks only; the census state row is not one of them.
    watermarks: new Map(
      [...workspace.syncState].filter(([key]) => key !== CENSUS_STATE_ID),
    ),
    ticks,
  };
}

function seedCensusComplete() {
  workspace.syncState.set(CENSUS_STATE_ID, {
    watermark: null,
    backfillCompletedAt: new Date('2026-08-01T00:00:00Z'),
  });
}

beforeEach(() => {
  workspace.channels = [];
  workspace.failing.clear();
  workspace.historyCalls = 0;
  workspace.syncState.clear();
  workspace.brainPages.clear();
  workspace.items.clear();
  workspace.retired = [];
  // Collection holds until the one-time inventory census completes.
  seedCensusComplete();
});

describe('slack collector against a fake Slack', () => {
  it('ingests every message in a quiet workspace and advances', async () => {
    const now = Date.now();
    workspace.channels = [
      seedChannel('C1', 'general', 20, 2 * DAY_MS, now),
      seedChannel('C2', 'ops', 5, 2 * DAY_MS, now),
    ];

    const { ingested, watermarks } = await drainToCaughtUp(
      new Date(now - 3 * DAY_MS),
    );

    expect(ingested.size).toBe(25);
    // Emitted slugs are gbrain-canonical: the store lowercases on write, so
    // tracking any other case would inventory pages that never exist.
    for (const slug of workspace.brainPages.keys()) {
      expect(slug).toBe(slug.toLowerCase());
    }
    expect(watermarks.size).toBe(2);
    expect([...workspace.brainPages.values()].join('\n')).toContain(
      '[Alice Example](people/roomote-member-',
    );
    expect([...workspace.brainPages.values()].join('\n')).not.toContain(
      'alice@example.com',
    );
  });

  it('loses nothing in a channel far busier than one page', async () => {
    // The original bug: one page of a newest-first read, then the watermark
    // jumps past everything older in the same window.
    const now = Date.now();
    workspace.channels = [seedChannel('C1', 'busy', 900, 3 * DAY_MS, now)];

    const { ingested } = await drainToCaughtUp(new Date(now - 4 * DAY_MS));

    expect(ingested.size).toBe(900);
  });

  it('catches up across a long backlog without stalling', async () => {
    // Watermark far behind, so the time-sliced window has to walk forward
    // repeatedly rather than either skipping or spinning.
    const now = Date.now();
    workspace.channels = [seedChannel('C1', 'history', 400, 10 * DAY_MS, now)];

    const { ingested, ticks } = await drainToCaughtUp(
      new Date(now - 11 * DAY_MS),
    );

    expect(ingested.size).toBe(400);
    // It should take several passes, and still terminate well short of the cap.
    expect(ticks).toBeGreaterThan(1);
    expect(ticks).toBeLessThan(60);
  });

  it('holds only the channel that cannot be read', async () => {
    const now = Date.now();
    workspace.channels = [
      seedChannel('C1', 'fine', 10, DAY_MS, now),
      seedChannel('C2', 'broken', 10, DAY_MS, now),
    ];
    workspace.failing.add('C2');

    workspace.syncState.set(slackStateId('C1'), {
      watermark: new Date(now - 2 * DAY_MS),
    });
    workspace.syncState.set(slackStateId('C2'), {
      watermark: new Date(now - 2 * DAY_MS),
    });
    const first = await slackPublicChannelsCollector.collect({
      since: null,
      now: new Date(now),
      limit: 100,
    });
    applyResult(first);

    expect(
      workspace.syncState.get(slackStateId('C1'))?.watermark?.getTime(),
    ).toBeGreaterThan(now - 2 * DAY_MS);
    expect(
      workspace.syncState.get(slackStateId('C2'))?.watermark?.getTime(),
    ).toBe(now - 2 * DAY_MS);
  });

  it('recovers the unread window once the failure clears', async () => {
    const now = Date.now();
    workspace.channels = [
      seedChannel('C1', 'fine', 10, DAY_MS, now),
      seedChannel('C2', 'flaky', 10, DAY_MS, now),
    ];
    workspace.failing.add('C2');

    workspace.syncState.set(slackStateId('C1'), {
      watermark: new Date(now - 2 * DAY_MS),
    });
    workspace.syncState.set(slackStateId('C2'), {
      watermark: new Date(now - 2 * DAY_MS),
    });
    const failed = await slackPublicChannelsCollector.collect({
      since: null,
      now: new Date(now),
      limit: 100,
    });
    applyResult(failed);

    workspace.failing.clear();
    const { ingested } = await drainToCaughtUp();

    // Nothing was skipped by the earlier failure.
    expect(ingested.size).toBe(20);
  });

  it('does not advance past now when the watermark is already current', async () => {
    // The window floor once pushed the watermark into the future, which would
    // skip whatever was posted in the gap on every steady-state tick.
    const now = Date.now();
    workspace.channels = [seedChannel('C1', 'general', 3, 60 * 1000, now)];
    workspace.syncState.set(slackStateId('C1'), {
      watermark: new Date(now - 60 * 1000),
    });

    const result = await slackPublicChannelsCollector.collect({
      since: null,
      now: new Date(now),
      limit: 100,
    });

    for (const update of result.stateUpdates ?? []) {
      if (!update.watermark) continue;
      expect(update.watermark.getTime()).toBeLessThanOrEqual(now);
    }
  });

  it('re-reading the same window changes nothing', async () => {
    const now = Date.now();
    workspace.channels = [seedChannel('C1', 'general', 40, DAY_MS, now)];

    const first = await drainToCaughtUp(new Date(now - 2 * DAY_MS));
    const callsAfterFirst = workspace.historyCalls;
    workspace.syncState.clear();
    seedCensusComplete();
    const second = await drainToCaughtUp(new Date(now - 2 * DAY_MS));

    expect(second.ingested).toEqual(first.ingested);
    expect(workspace.historyCalls).toBeGreaterThan(callsAfterFirst);
  });

  it('keeps earlier same-day chunks when a later tick lands', async () => {
    const firstTick = Date.parse('2026-08-13T10:15:00Z');
    const secondTick = Date.parse('2026-08-13T10:30:00Z');
    workspace.channels = [
      {
        id: 'C1',
        name: 'general',
        messages: [
          {
            ts: String(Date.parse('2026-08-13T10:05:00Z') / 1000),
            text: 'C1 message 0',
            user: 'U1',
          },
          {
            ts: String(Date.parse('2026-08-13T10:20:00Z') / 1000),
            text: 'C1 message 1',
            user: 'U1',
          },
        ],
      },
    ];
    workspace.syncState.set(slackStateId('C1'), {
      watermark: new Date('2026-08-13T10:00:00Z'),
    });

    const first = await slackPublicChannelsCollector.collect({
      since: null,
      now: new Date(firstTick),
      limit: 100,
    });
    applyResult(first);
    const second = await slackPublicChannelsCollector.collect({
      since: null,
      now: new Date(secondTick),
      limit: 100,
    });
    applyResult(second);

    expect(workspace.brainPages.size).toBe(2);
    expect(ingestedMessages()).toEqual(
      new Set(['C1 message 0', 'C1 message 1']),
    );
    // The later partial-day tick covers only its own window, so the earlier
    // chunk's range is never contained and retirement must not fire.
    expect(workspace.retired).toEqual([]);
  });

  it('holds all collection until the inventory census completes', async () => {
    workspace.syncState.delete(CENSUS_STATE_ID);
    workspace.channels = [seedChannel('C1', 'general', 5, DAY_MS, Date.now())];

    const incremental = await slackPublicChannelsCollector.collect({
      since: null,
      now: new Date(),
      limit: 100,
    });
    const backfill = await slackPublicChannelsCollector.backfill!({
      cursor: null,
      limit: 100,
    });

    expect(incremental.pages).toEqual([]);
    expect(incremental.stateUpdates ?? []).toEqual([]);
    expect(backfill.pages).toEqual([]);
    expect(backfill.done).toBe(false);
    expect(workspace.historyCalls).toBe(0);
  });

  it('steady-state incremental ticks never retire pages', async () => {
    const now = Date.now();
    workspace.channels = [seedChannel('C1', 'general', 60, 3 * DAY_MS, now)];

    const { ingested } = await drainToCaughtUp(new Date(now - 4 * DAY_MS));

    expect(ingested.size).toBe(60);
    expect(workspace.retired).toEqual([]);
    // Every emitted page is inventoried under its own slug.
    expect(new Set(workspace.items.keys())).toEqual(
      new Set(workspace.brainPages.keys()),
    );
  });

  it('lets quiet channels advance when one pathological channel holds', async () => {
    const now = Date.now();
    workspace.channels = [
      seedChannel('C1', 'pathological', 10_001, 999, now),
      seedChannel('C2', 'normal', 3, 1000, now),
    ];
    workspace.syncState.set(slackStateId('C1'), {
      watermark: new Date(now - 1000),
    });
    workspace.syncState.set(slackStateId('C2'), {
      watermark: new Date(now - 1000),
    });

    const result = await slackPublicChannelsCollector.collect({
      since: null,
      now: new Date(now),
      limit: 100,
    });
    applyResult(result);

    expect(
      workspace.syncState.get(slackStateId('C1'))?.watermark?.getTime(),
    ).toBe(now - 1000);
    expect(
      workspace.syncState.get(slackStateId('C2'))?.watermark?.getTime(),
    ).toBe(now);
  });
});

describe('slug retirement heals pages from the incremental era', () => {
  it('a replay retires the partial-day chunks it fully supersedes', async () => {
    // Phase 1: the incremental era. Two ticks land the same day as two
    // immutable partial-day chunks, tracked in the inventory as the engine
    // would have.
    workspace.channels = [
      {
        id: 'C1',
        name: 'general',
        messages: [
          {
            ts: (Date.parse('2026-08-13T10:05:00Z') / 1000).toFixed(6),
            text: 'C1 message 0',
            user: 'U1',
          },
          {
            ts: (Date.parse('2026-08-13T10:20:00Z') / 1000).toFixed(6),
            text: 'C1 message 1',
            user: 'U1',
          },
        ],
      },
    ];
    workspace.syncState.set(slackStateId('C1'), {
      watermark: new Date('2026-08-13T10:00:00Z'),
    });

    for (const tick of ['2026-08-13T10:15:00Z', '2026-08-13T10:30:00Z']) {
      applyResult(
        await slackPublicChannelsCollector.collect({
          since: null,
          now: new Date(tick),
          limit: 100,
        }),
      );
    }

    const legacySlugs = [...workspace.brainPages.keys()];
    expect(legacySlugs).toHaveLength(2);

    // Phase 2: a version bump. Collector state starts over (the census has
    // already run — the inventory survives, keyed off the unversioned id),
    // and the fresh watermark re-reads the whole day in one window.
    workspace.syncState.clear();
    seedCensusComplete();
    workspace.syncState.set(slackStateId('C1'), {
      watermark: new Date('2026-08-13T00:00:00Z'),
    });

    applyResult(
      await slackPublicChannelsCollector.collect({
        since: null,
        now: new Date('2026-08-14T00:30:00Z'),
        limit: 100,
      }),
    );

    // Both messages live in exactly one whole-day page; the superseded
    // chunks are gone from the Brain and from the inventory.
    expect(workspace.retired.sort()).toEqual(legacySlugs.sort());
    expect(workspace.brainPages.size).toBe(1);
    expect(ingestedMessages()).toEqual(
      new Set(['C1 message 0', 'C1 message 1']),
    );
    expect(new Set(workspace.items.keys())).toEqual(
      new Set(workspace.brainPages.keys()),
    );
  });

  it('keeps a page whose range reaches outside what was re-read', async () => {
    // A census-seeded legacy page claims messages from 09:00, but the only
    // messages Slack still serves are later. Retiring it would discard the
    // only record of whatever the 09:00 half described.
    const wide = legacyChunkSlug(
      'C1',
      '2026-08-13',
      '2026-08-13T09:00:00Z',
      '2026-08-13T10:20:00Z',
    );
    // Strictly inside the re-read range and different from any re-emitted
    // slug (a legacy batch boundary the replay does not reproduce).
    const inside = legacyChunkSlug(
      'C1',
      '2026-08-13',
      '2026-08-13T10:06:00Z',
      '2026-08-13T10:19:00Z',
    );
    seedLegacyPage(wide);
    seedLegacyPage(inside);
    workspace.channels = [
      {
        id: 'C1',
        name: 'general',
        messages: [
          {
            ts: (Date.parse('2026-08-13T10:05:00Z') / 1000).toFixed(6),
            text: 'C1 message 0',
            user: 'U1',
          },
          {
            ts: (Date.parse('2026-08-13T10:20:00Z') / 1000).toFixed(6),
            text: 'C1 message 1',
            user: 'U1',
          },
        ],
      },
    ];
    workspace.syncState.set(slackStateId('C1'), {
      watermark: new Date('2026-08-13T00:00:00Z'),
    });

    applyResult(
      await slackPublicChannelsCollector.collect({
        since: null,
        now: new Date('2026-08-14T00:30:00Z'),
        limit: 100,
      }),
    );

    expect(workspace.retired).toEqual([inside]);
    expect(workspace.brainPages.has(wide)).toBe(true);
  });

  it('retires nothing for a day the re-read returns no messages for', async () => {
    // Retention or upstream deletion can empty a day. No emission means no
    // coverage, so the old pages — possibly the only surviving record —
    // stay.
    const orphan = legacyChunkSlug(
      'C1',
      '2026-08-13',
      '2026-08-13T10:05:00Z',
      '2026-08-13T10:20:00Z',
    );
    seedLegacyPage(orphan);
    workspace.channels = [{ id: 'C1', name: 'general', messages: [] }];
    workspace.syncState.set(slackStateId('C1'), {
      watermark: new Date('2026-08-13T00:00:00Z'),
    });

    applyResult(
      await slackPublicChannelsCollector.collect({
        since: null,
        now: new Date('2026-08-14T00:30:00Z'),
        limit: 100,
      }),
    );

    expect(workspace.retired).toEqual([]);
    expect(workspace.brainPages.has(orphan)).toBe(true);
  });

  it('the deep backfill replay heals covered chunks and keeps straddlers', async () => {
    // Anchor at UTC noon three days ago: old enough for the backfill window
    // (which ends a day before now), and a two-minute span that can never
    // straddle a UTC day boundary.
    const anchor = new Date(Date.now() - 3 * DAY_MS);
    anchor.setUTCHours(12, 0, 0, 0);
    const messageAt = (offsetMs: number) => anchor.getTime() + offsetMs;
    workspace.channels = [
      {
        id: 'C1',
        name: 'general',
        messages: [0, 60_000, 120_000].map((offset, index) => ({
          ts: (messageAt(offset) / 1000).toFixed(6),
          text: `C1 message ${index}`,
          user: 'U1',
        })),
      },
    ];
    const day = new Date(messageAt(0)).toISOString().slice(0, 10);
    const iso = (offsetMs: number) =>
      new Date(messageAt(offsetMs)).toISOString();
    const covered = legacyChunkSlug('C1', day, iso(0), iso(60_000));
    const straddler = legacyChunkSlug('C1', day, iso(-3_600_000), iso(60_000));
    seedLegacyPage(covered);
    seedLegacyPage(straddler);

    let cursor: string | null = null;
    for (let steps = 0; steps < 10; steps++) {
      const step = await slackPublicChannelsCollector.backfill!({
        cursor,
        limit: 100,
      });
      applyResult(step);
      if (step.nextCursor === cursor) break;
      cursor = step.nextCursor;
    }

    // The chunk whose whole range was re-read is retired; the one reaching
    // an hour before the earliest surviving message is kept.
    expect(workspace.retired).toEqual([covered]);
    expect(workspace.brainPages.has(straddler)).toBe(true);
    expect(ingestedMessages()).toEqual(
      new Set(['C1 message 0', 'C1 message 1', 'C1 message 2']),
    );
  });
});
