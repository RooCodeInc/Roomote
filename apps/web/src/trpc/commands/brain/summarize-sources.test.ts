/**
 * Row shapes below are lifted from a real deployment where the previous
 * derivation misread nearly every source: rolling-cursor collectors showed
 * "Backfilling" forever, version-bump orphans and a census row inflated
 * "37 streams" out of 17 channels, and the one "read" stream was the census.
 */

import { describe, expect, it } from 'vitest';

import { summarizeSources } from './index';

type SyncRow = {
  id: string;
  collectorId: string;
  watermark: Date | null;
  backfillCursor: string | null;
  backfillCompletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function row(
  collectorId: string,
  fields: Partial<
    Pick<SyncRow, 'watermark' | 'backfillCursor' | 'backfillCompletedAt'>
  > = {},
): SyncRow {
  return {
    id: collectorId,
    collectorId,
    watermark: null,
    backfillCursor: null,
    backfillCompletedAt: null,
    createdAt: new Date('2026-08-18T00:00:00Z'),
    updatedAt: new Date('2026-08-20T00:00:00Z'),
    ...fields,
  };
}

const ALL_CONNECTED = {
  slack: true,
  discord: true,
  github: true,
  notion: true,
  granola: true,
  rippling: false,
  linear: true,
} as const;

function summarize(
  syncStates: SyncRow[],
  requirements: Partial<Record<keyof typeof ALL_CONNECTED, boolean>> = {},
) {
  return summarizeSources({
    syncStates,
    itemCounts: [],
    requirements: { ...ALL_CONNECTED, ...requirements },
    taskMemoriesActive: true,
    taskMemoriesLastProcessedAt: new Date('2026-08-20T18:50:00Z'),
  });
}

function sourceOf(sources: ReturnType<typeof summarize>, id: string) {
  const source = sources.find((candidate) => candidate.id === id);
  if (!source) throw new Error(`missing source ${id}`);
  return source;
}

const watermark = new Date('2026-08-20T18:55:00Z');

describe('summarizeSources', () => {
  it('counts only the current collector version, not orphans or the census', () => {
    const channels = ['T1/C1', 'T1/C2', 'T1/C3'];
    const sources = summarize([
      // Current version: parent mid-replay plus one row per channel.
      row('slack-public-channels:entity-timeline-v3', {
        backfillCursor: JSON.stringify({ completed: ['T1/C1'] }),
      }),
      ...channels.map((key) =>
        row(`slack-public-channels:entity-timeline-v3:${key}`, { watermark }),
      ),
      // Version-bump orphans and the census: excluded entirely.
      row('slack-public-channels:entity-timeline-v2', {
        backfillCursor: JSON.stringify({ completed: channels }),
      }),
      ...channels.map((key) =>
        row(`slack-public-channels:entity-timeline-v2:${key}`, { watermark }),
      ),
      row('slack-public-channels:day-pages:census', {
        backfillCompletedAt: new Date('2026-08-20T01:55:00Z'),
      }),
    ]);
    const slack = sourceOf(sources, 'slack-public-channels');

    expect(slack.status).toBe('backfilling');
    expect(slack.streams).toBe(3);
    // Progress comes from the walk's own completed set, not from completion
    // timestamps (channel rows never carry one) and not from the census.
    expect(slack.backfillProgress).toEqual({ read: 1, total: 3 });
    expect(slack.lastSyncedAt).toEqual(watermark);
  });

  it('treats rolling-cursor collectors as ingesting, not backfilling', () => {
    const sources = summarize([
      // Pull-request facts: a keyset resume cursor beside a live watermark.
      row('pull-request-facts:occurrence-date-v3', {
        watermark,
        backfillCursor: JSON.stringify({
          updatedAt: watermark.toISOString(),
          id: 'a9d090bd',
        }),
      }),
      // Member sweep: a mode-state cursor beside a live watermark.
      row('person-identities:members:occurrence-date-v2', {
        watermark,
        backfillCursor: JSON.stringify({ mode: 'idle' }),
      }),
      // Notion: backfill genuinely finished; the incremental scan holds a
      // rolling cursor of its own.
      row('notion-pages', {
        backfillCompletedAt: new Date('2026-08-18T15:01:00Z'),
      }),
      row('notion-pages:incremental', {
        watermark,
        backfillCursor: JSON.stringify({ mode: 'idle', lastSweepAt: null }),
      }),
    ]);

    expect(sourceOf(sources, 'pull-request-facts').status).toBe('ingesting');
    expect(sourceOf(sources, 'person-identities').status).toBe('ingesting');
    expect(sourceOf(sources, 'notion-pages').status).toBe('ingesting');
    expect(sourceOf(sources, 'pull-request-facts').backfillProgress).toBeNull();
  });

  it('does not treat a child snapshot cursor as a deep backfill', () => {
    const sources = summarize(
      [
        row('rippling-workers:snapshot', {
          backfillCursor: JSON.stringify({ page: 2 }),
        }),
      ],
      { rippling: true },
    );
    const rippling = sourceOf(sources, 'rippling-workers');

    expect(rippling.status).toBe('ingesting');
    expect(rippling.backfillProgress).toBeNull();
  });

  it('shows a completed fan-out backfill as ingesting', () => {
    const sources = summarize([
      row('slack-public-channels:entity-timeline-v3', {
        backfillCursor: JSON.stringify({ completed: ['T1/C1'] }),
        backfillCompletedAt: new Date('2026-08-20T19:00:00Z'),
      }),
      row('slack-public-channels:entity-timeline-v3:T1/C1', { watermark }),
    ]);
    const slack = sourceOf(sources, 'slack-public-channels');

    expect(slack.status).toBe('ingesting');
    expect(slack.backfillProgress).toBeNull();
  });

  it('falls back to completion timestamps for non-fan-out backfills', () => {
    const sources = summarize([
      row('notion-pages', {
        backfillCursor: JSON.stringify({ next: 'abc' }),
      }),
      row('notion-pages:incremental', {
        backfillCompletedAt: new Date('2026-08-18T15:01:00Z'),
      }),
    ]);
    const notion = sourceOf(sources, 'notion-pages');

    expect(notion.status).toBe('backfilling');
    expect(notion.backfillProgress).toEqual({ read: 1, total: 1 });
  });

  it('reports a disconnected requirement over any sync state', () => {
    const sources = summarize([], { linear: false });

    expect(sourceOf(sources, 'rippling-workers').status).toBe('not_connected');
    expect(sourceOf(sources, 'linear-issues').status).toBe('not_connected');
    expect(sourceOf(sources, 'task-memories').status).toBe('ingesting');
    expect(sourceOf(sources, 'task-memories').lastSyncedAt).toEqual(
      new Date('2026-08-20T18:50:00Z'),
    );
  });
});
