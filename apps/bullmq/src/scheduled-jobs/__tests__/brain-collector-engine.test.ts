import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deleteBrainCollectorItems,
  getBrainSyncState,
  upsertBrainCollectorItems,
  upsertBrainSyncState,
} from '@roomote/db/server';
import { runBrainCollectors } from '../brain-collectors';
import type {
  BrainCollector,
  BrainRetireSink,
  BrainSink,
  CollectorPage,
} from '../brain-collectors/contracts';
import {
  retireBrainPage,
  writeCollectorPages,
} from '../brain-collectors/write-pages';
import { BrainRateLimitedError } from '../brain-outbox-drain';

type FakeSyncState = {
  watermark: Date | null;
  backfillCursor: string | null;
  backfillCompletedAt: Date | null;
};
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
    upsertBrainCollectorItems: vi.fn(async () => {}),
    deleteBrainCollectorItems: vi.fn(async () => {}),
  };
});
const mockedUpsertSyncState = vi.mocked(upsertBrainSyncState);
const mockedGetSyncState = vi.mocked(getBrainSyncState);
const mockedUpsertCollectorItems = vi.mocked(upsertBrainCollectorItems);
const mockedDeleteCollectorItems = vi.mocked(deleteBrainCollectorItems);
beforeEach(() => {
  syncStateStore.clear();
  mockedUpsertSyncState.mockClear();
  mockedGetSyncState.mockClear();
  mockedUpsertCollectorItems.mockClear();
  mockedDeleteCollectorItems.mockClear();
});
const connection = { baseUrl: 'http://brain.test', token: 'test-token' };
function makePages(count: number, prefix = 'page'): CollectorPage[] {
  return Array.from({ length: count }, (_, index) => ({
    slug: `${prefix}/${index}`,
    title: `${prefix} ${index}`,
    content: `content ${index}`,
  }));
}
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

describe('writeCollectorPages', () => {
  it('redacts and writes each page before its timeline evidence', async () => {
    const calls: string[] = [];
    const sink: BrainSink = vi.fn(async (page) => {
      calls.push(`page:${page.content}`);
    });
    const timelineSink = vi.fn(async (evidence) => {
      calls.push(`timeline:${evidence.summary}:${evidence.detail}`);
    });

    await writeCollectorPages({
      pages: [
        {
          slug: 'page/1',
          title: 'Page 1',
          content: 'token ghp_abcdefghijklmnopqrstuvwxyz',
          timelineEvidence: [
            {
              slug: 'people/1',
              date: '2026-08-19',
              summary: 'used sk-abcdefghijklmnopqrstuvwxyz',
              detail: 'Bearer abcdefghijklmnopqrstuvwxyz',
              source: 'test',
            },
          ],
        },
      ],
      connection,
      sink,
      timelineSink,
    });

    expect(calls).toEqual([
      'page:token [REDACTED]',
      'timeline:used [REDACTED]:[REDACTED]',
    ]);
  });
});

describe('retireBrainPage', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function bodyOf(status: number, body: string) {
    global.fetch = vi.fn(
      async () => new Response(body, { status }),
    ) as unknown as typeof fetch;
  }

  it('treats an already-deleted page as retired', async () => {
    bodyOf(
      200,
      '{"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"page_not_found: slack/T1/C1"}]}}',
    );

    await expect(
      retireBrainPage('slack/T1/C1/2026-08-13/1-0-2-0', connection),
    ).resolves.toBeUndefined();
  });

  it('keeps backpressure typed so the engine ends the pass', async () => {
    bodyOf(429, 'rate limited');

    await expect(
      retireBrainPage('slack/T1/C1/2026-08-13/1-0-2-0', connection),
    ).rejects.toBeInstanceOf(BrainRateLimitedError);
  });

  it('propagates other failures', async () => {
    bodyOf(500, 'internal error');

    await expect(
      retireBrainPage('slack/T1/C1/2026-08-13/1-0-2-0', connection),
    ).rejects.toThrow('delete_page failed');
  });
});

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

  it('persists collector inventory changes only after every page lands', async () => {
    const seenAt = new Date('2026-08-15T12:00:00Z');
    const collector = makeCollector({
      collect: async () => ({
        pages: makePages(1),
        nextSince: null,
        itemUpdates: [
          {
            collectorId: 'notion-pages',
            itemId: 'page-1',
            slug: 'notion/page1',
            lastSeenAt: seenAt,
          },
        ],
        itemDeletes: [
          { collectorId: 'notion-pages', itemIds: ['revoked-page'] },
        ],
      }),
    });

    await runBrainCollectors(connection, {
      sink: vi.fn(async () => {}),
      collectors: [collector],
    });

    expect(mockedUpsertCollectorItems).toHaveBeenCalledWith(
      expect.anything(),
      'notion-pages',
      [
        {
          collectorId: 'notion-pages',
          itemId: 'page-1',
          slug: 'notion/page1',
          lastSeenAt: seenAt,
        },
      ],
    );
    expect(mockedDeleteCollectorItems).toHaveBeenCalledWith(
      expect.anything(),
      'notion-pages',
      ['revoked-page'],
    );
  });

  it('retires superseded pages once the batch has landed', async () => {
    const order: string[] = [];
    const collector = makeCollector({
      collect: async () => ({
        pages: makePages(1),
        nextSince: null,
        pageRetirements: [
          {
            collectorId: 'slack-public-channels:day-pages',
            itemId: 'slack/T1/C1/2026-08-13/1-0-2-0',
            slug: 'slack/T1/C1/2026-08-13/1-0-2-0',
          },
        ],
      }),
    });
    const sink: BrainSink = vi.fn(async (page) => {
      order.push(`write:${page.slug}`);
    });
    const retireSink: BrainRetireSink = vi.fn(async (slug) => {
      order.push(`retire:${slug}`);
    });

    await runBrainCollectors(connection, {
      sink,
      retireSink,
      collectors: [collector],
    });

    // The superseding page lands before the superseded one goes, and only a
    // successful retirement drops the inventory row.
    expect(order).toEqual([
      'write:page/0',
      'retire:slack/T1/C1/2026-08-13/1-0-2-0',
    ]);
    expect(mockedDeleteCollectorItems).toHaveBeenCalledWith(
      expect.anything(),
      'slack-public-channels:day-pages',
      ['slack/T1/C1/2026-08-13/1-0-2-0'],
    );
  });

  it('holds retirements when a page fails', async () => {
    const retireSink: BrainRetireSink = vi.fn(async () => {});
    const collector = makeCollector({
      collect: async () => ({
        pages: makePages(1),
        nextSince: null,
        pageRetirements: [{ collectorId: 'c', itemId: 'i', slug: 'slack/old' }],
      }),
    });

    await runBrainCollectors(connection, {
      sink: vi.fn(async () => {
        throw new Error('boom');
      }),
      retireSink,
      collectors: [collector],
    });

    expect(retireSink).not.toHaveBeenCalled();
    expect(mockedDeleteCollectorItems).not.toHaveBeenCalled();
  });

  it('holds retirements when the collector overshoots the page cap', async () => {
    // On overshoot part of the emission never landed, so pages the dropped
    // remainder would have superseded must stay until it does.
    const retireSink: BrainRetireSink = vi.fn(async () => {});
    const collector = makeCollector({
      collect: async () => ({
        pages: makePages(150),
        nextSince: null,
        pageRetirements: [{ collectorId: 'c', itemId: 'i', slug: 'slack/old' }],
      }),
    });

    await runBrainCollectors(connection, {
      sink: vi.fn(async () => {}),
      retireSink,
      collectors: [collector],
    });

    expect(retireSink).not.toHaveBeenCalled();
  });

  it('keeps the inventory row when a retirement fails, and holds state', async () => {
    const collector = makeCollector({
      collect: async () => ({
        pages: makePages(1),
        nextSince: new Date('2026-08-13T10:00:00Z'),
        pageRetirements: [{ collectorId: 'c', itemId: 'i', slug: 'slack/old' }],
      }),
    });

    await runBrainCollectors(connection, {
      sink: vi.fn(async () => {}),
      retireSink: vi.fn(async () => {
        throw new Error('delete_page exploded');
      }),
      collectors: [collector],
    });

    // The failed retirement is retried next pass: its row survives and the
    // watermark stays behind so the same window is recomputed.
    expect(mockedDeleteCollectorItems).not.toHaveBeenCalled();
    expect(syncStateStore.get(collector.id)).toBeUndefined();
  });

  it('holds collector inventory changes when a page fails', async () => {
    const collector = makeCollector({
      collect: async () => ({
        pages: makePages(1),
        nextSince: null,
        itemDeletes: [
          { collectorId: 'notion-pages', itemIds: ['revoked-page'] },
        ],
      }),
    });

    await runBrainCollectors(connection, {
      sink: vi.fn(async () => {
        throw new Error('boom');
      }),
      collectors: [collector],
    });

    expect(mockedDeleteCollectorItems).not.toHaveBeenCalled();
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

  it("retires a step's superseded pages before its cursor persists", async () => {
    const retireSink: BrainRetireSink = vi
      .fn<BrainRetireSink>()
      .mockRejectedValueOnce(new Error('delete_page exploded'))
      .mockResolvedValue(undefined);
    const backfill = vi
      .fn<NonNullable<BrainCollector['backfill']>>()
      .mockImplementation(async ({ cursor }) =>
        cursor === null
          ? {
              pages: makePages(1, 'replay'),
              nextCursor: 'c1',
              done: false,
              pageRetirements: [
                { collectorId: 'c', itemId: 'i', slug: 'slack/old' },
              ],
            }
          : { pages: [], nextCursor: cursor, done: false },
      );
    const collector = makeCollector({
      collect: async () => ({ pages: [], nextSince: null }),
      backfill,
    });

    await runBrainCollectors(connection, {
      sink: vi.fn(async () => {}),
      retireSink,
      collectors: [collector],
    });

    // The failed retirement held the cursor, so the same step re-runs.
    expect(syncStateStore.get(collector.id)?.backfillCursor).toBeUndefined();

    await runBrainCollectors(connection, {
      sink: vi.fn(async () => {}),
      retireSink,
      collectors: [collector],
    });

    expect(retireSink).toHaveBeenCalledTimes(2);
    expect(syncStateStore.get(collector.id)?.backfillCursor).toBe('c1');
    expect(mockedDeleteCollectorItems).toHaveBeenCalledWith(
      expect.anything(),
      'c',
      ['i'],
    );
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

  it('retries the same timeline evidence before advancing its watermark', async () => {
    const evidence = {
      slug: 'people/member-a',
      date: '2026-08-17',
      summary: 'Participated in #general',
      source: 'slack/team/general/batch',
    };
    const collector = makeCollector({
      collect: async () => ({
        pages: [
          {
            slug: evidence.source,
            title: 'Slack batch',
            content: 'content',
            timelineEvidence: [evidence],
          },
        ],
        nextSince: new Date('2026-08-18T00:00:00Z'),
      }),
    });
    const timelineSink = vi
      .fn()
      .mockRejectedValueOnce(new Error('timeline unavailable'))
      .mockResolvedValueOnce(undefined);

    await runBrainCollectors(connection, {
      sink: vi.fn(async () => {}),
      timelineSink,
      collectors: [collector],
    });
    expect(syncStateStore.get(collector.id)?.watermark).toBeUndefined();

    await runBrainCollectors(connection, {
      sink: vi.fn(async () => {}),
      timelineSink,
      collectors: [collector],
    });
    expect(timelineSink).toHaveBeenNthCalledWith(1, evidence, connection);
    expect(timelineSink).toHaveBeenNthCalledWith(2, evidence, connection);
    expect(syncStateStore.get(collector.id)?.watermark).toEqual(
      new Date('2026-08-18T00:00:00Z'),
    );
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
