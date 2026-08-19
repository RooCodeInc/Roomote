import { beforeEach, describe, expect, it, vi } from 'vitest';

import { listBrainCollectorItemsBefore } from '@roomote/db/server';
import { NotionApiError } from '@roomote/sdk/server/notion-api';

import {
  buildNotionPage,
  buildNotionSearchBody,
  buildNotionSweepInventory,
  buildUnavailableNotionPage,
  collectNotionReconciliation,
  type NotionSearchPage,
} from '../brain-collectors/notion-pages';

const mockNotionApiRequestJson = vi.hoisted(() => vi.fn());
vi.mock('@roomote/sdk/server/notion-api', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@roomote/sdk/server/notion-api')>();
  return { ...original, notionApiRequestJson: mockNotionApiRequestJson };
});
vi.mock('@roomote/db/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('@roomote/db/server')>();
  return { ...original, listBrainCollectorItemsBefore: vi.fn(async () => []) };
});
const mockedListCollectorItemsBefore = vi.mocked(listBrainCollectorItemsBefore);
beforeEach(() => {
  mockedListCollectorItemsBefore.mockReset();
  mockedListCollectorItemsBefore.mockResolvedValue([]);
  mockNotionApiRequestJson.mockReset();
});

describe('Notion page mapping', () => {
  const page: NotionSearchPage = {
    object: 'page',
    id: '12345678-90AB-CDEF-1234-567890ABCDEF',
    created_time: '2026-08-13T14:30:00.000Z',
    last_edited_time: '2026-08-15T01:20:00.000Z',
    url: 'https://www.notion.so/Project-brief-1234567890abcdef1234567890abcdef',
    properties: {
      Name: {
        type: 'title',
        title: [{ plain_text: 'Project ' }, { text: { content: 'brief' } }],
      },
    },
  };

  it('uses a stable page-id slug and preserves source dates and Markdown', () => {
    const mapped = buildNotionPage(page, {
      markdown: '## Decision\n\nShip the collector.',
    });

    expect(mapped).toMatchObject({
      slug: 'notion/1234567890abcdef1234567890abcdef',
      title: 'Project brief',
    });
    expect(mapped?.content).toContain('date: 2026-08-15');
    expect(mapped?.content).toContain('created_at: 2026-08-13T14:30:00.000Z');
    expect(mapped?.content).toContain(
      'last_edited_at: 2026-08-15T01:20:00.000Z',
    );
    expect(mapped?.content).toContain('## Decision\n\nShip the collector.');
  });

  it('replaces the old body with a tombstone when Notion reports trash', () => {
    const mapped = buildNotionPage({ ...page, in_trash: true }, {});

    expect(mapped?.content).toContain('status: deleted');
    expect(mapped?.content).toContain('This page is in the Notion trash.');
  });

  it('marks snapshots that Notion truncated', () => {
    const mapped = buildNotionPage(page, {
      markdown: '# Partial body',
      truncated: true,
    });

    expect(mapped?.content).toContain(
      'Notion truncated this Markdown snapshot',
    );
  });

  it('replaces an unshared page at the same slug with an unavailable tombstone', () => {
    const mapped = buildUnavailableNotionPage({
      itemId: page.id,
      slug: 'notion/1234567890abcdef1234567890abcdef',
    });

    expect(mapped.slug).toBe('notion/1234567890abcdef1234567890abcdef');
    expect(mapped.content).toContain('status: unavailable');
    expect(mapped.content).toContain(
      'This page is no longer available to the Notion integration.',
    );
  });

  it('searches pages newest-first and carries the durable Notion cursor', () => {
    expect(buildNotionSearchBody('next-page', 100)).toEqual({
      filter: { property: 'object', value: 'page' },
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
      page_size: 20,
      start_cursor: 'next-page',
    });
  });

  it('marks every visible sweep result as seen even when it was edited during the scan', () => {
    const scanStartedAt = new Date('2026-08-15T01:00:00Z');
    const inventory = buildNotionSweepInventory(
      [
        page,
        {
          ...page,
          id: 'newly-edited-page',
          last_edited_time: '2026-08-15T01:01:00Z',
        },
      ],
      scanStartedAt,
    );

    expect(inventory).toEqual([
      expect.objectContaining({ itemId: page.id, lastSeenAt: scanStartedAt }),
      expect.objectContaining({
        itemId: 'newly-edited-page',
        lastSeenAt: scanStartedAt,
      }),
    ]);
  });

  it('tombstones tracked pages that were absent from a completed sweep', async () => {
    mockedListCollectorItemsBefore.mockResolvedValue([
      {
        collectorId: 'notion-pages',
        itemId: page.id,
        slug: 'notion/1234567890abcdef1234567890abcdef',
        lastSeenAt: new Date('2026-08-14T00:00:00Z'),
        createdAt: new Date('2026-08-14T00:00:00Z'),
        updatedAt: new Date('2026-08-14T00:00:00Z'),
      },
    ]);
    mockNotionApiRequestJson.mockRejectedValue(
      new NotionApiError('Not found', 404, 'object_not_found', null),
    );

    const result = await collectNotionReconciliation({
      config: { type: 'notion', encryptedToken: 'encrypted-test-token' },
      saved: {
        mode: 'reconcile',
        lastSweepAt: '2026-08-14T00:00:00Z',
        scanStartedAt: '2026-08-15T00:00:00Z',
      },
      limit: 100,
    });

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.content).toContain('status: unavailable');
    expect(result.itemDeletes).toEqual([
      { collectorId: 'notion-pages', itemIds: [page.id] },
    ]);
    expect(JSON.parse(result.stateUpdates?.[0]?.cursor ?? '{}')).toEqual({
      mode: 'idle',
      lastSweepAt: '2026-08-15T00:00:00.000Z',
    });
  });

  it('refreshes a page that moved during the sweep instead of tombstoning it', async () => {
    mockedListCollectorItemsBefore.mockResolvedValue([
      {
        collectorId: 'notion-pages',
        itemId: page.id,
        slug: 'notion/1234567890abcdef1234567890abcdef',
        lastSeenAt: new Date('2026-08-14T00:00:00Z'),
        createdAt: new Date('2026-08-14T00:00:00Z'),
        updatedAt: new Date('2026-08-14T00:00:00Z'),
      },
    ]);
    mockNotionApiRequestJson
      .mockResolvedValueOnce({
        ...page,
        last_edited_time: '2026-08-15T00:01:00Z',
      })
      .mockResolvedValueOnce({ markdown: '# Still shared' });

    const result = await collectNotionReconciliation({
      config: { type: 'notion', encryptedToken: 'encrypted-test-token' },
      saved: {
        mode: 'reconcile',
        lastSweepAt: '2026-08-14T00:00:00Z',
        scanStartedAt: '2026-08-15T00:00:00Z',
      },
      limit: 100,
    });

    expect(result.pages[0]?.content).toContain('# Still shared');
    expect(result.itemDeletes).toEqual([
      { collectorId: 'notion-pages', itemIds: [] },
    ]);
    expect(result.itemUpdates).toEqual([
      expect.objectContaining({
        itemId: page.id,
        lastSeenAt: new Date('2026-08-15T00:00:00Z'),
      }),
    ]);
  });
});
