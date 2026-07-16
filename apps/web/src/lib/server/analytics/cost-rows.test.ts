import { db, inArray, llmUsageEvents } from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

import { getCostAnalyticsRows } from './cost-rows';

describe('getCostAnalyticsRows', () => {
  const usageEventIds: string[] = [];

  afterEach(async () => {
    if (usageEventIds.length === 0) {
      return;
    }

    await db
      .delete(llmUsageEvents)
      .where(inArray(llmUsageEvents.id, usageEventIds));
    usageEventIds.length = 0;
  });

  it('encodes finite time-period cutoffs and excludes older usage', async () => {
    const now = new Date('2026-07-16T16:00:00.000Z');
    const insertedEvents = await db
      .insert(llmUsageEvents)
      .values([
        {
          eventKey: `cost-analytics-recent-${crypto.randomUUID()}`,
          costSource: 'missing',
          costMicroUsd: 1_000_000,
          messageCompletedAt: new Date('2026-07-15T12:00:00.000Z'),
        },
        {
          eventKey: `cost-analytics-old-${crypto.randomUUID()}`,
          costSource: 'missing',
          costMicroUsd: 2_000_000,
          messageCompletedAt: new Date('2026-07-01T12:00:00.000Z'),
        },
      ])
      .returning({ id: llmUsageEvents.id });
    const recentEvent = insertedEvents[0]!;
    const oldEvent = insertedEvents[1]!;

    usageEventIds.push(recentEvent.id, oldEvent.id);

    const rows = await getCostAnalyticsRows({} as UserAuthSuccess, 7, now);
    const rowIds = new Set(rows.map((row) => row.id));

    expect(rowIds.has(recentEvent.id)).toBe(true);
    expect(rowIds.has(oldEvent.id)).toBe(false);
  });
});
