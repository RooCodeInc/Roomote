import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  listBrainCollectorItemsAfter,
  listBrainCollectorItemsBefore,
  listBrainCollectorItemsBySlugPrefix,
} from '@roomote/db/server';
import { NotionApiError } from '@roomote/sdk/server/notion-api';

import {
  buildNotionPage,
  buildNotionSearchBody,
  buildNotionSweepInventory,
  buildNotionUserReferences,
  buildUnavailableNotionPage,
  collectNotionReconciliation,
  collectNotionTraversal,
  type NotionSearchPage,
  type NotionUserIdentity,
} from '../brain-collectors/notion-pages';
import { buildPersonIdentityLookup } from '../brain-collectors/person-identities';
import type { PersonIdentityRecord } from '../brain-collectors/identity';

const mockNotionApiRequestJson = vi.hoisted(() => vi.fn());
vi.mock('@roomote/sdk/server/notion-api', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@roomote/sdk/server/notion-api')>();
  return { ...original, notionApiRequestJson: mockNotionApiRequestJson };
});
vi.mock('@roomote/db/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('@roomote/db/server')>();
  return {
    ...original,
    listBrainCollectorItemsBefore: vi.fn(async () => []),
    listBrainCollectorItemsAfter: vi.fn(async () => []),
    listBrainCollectorItemsBySlugPrefix: vi.fn(async () => []),
  };
});
const mockedListCollectorItemsBefore = vi.mocked(listBrainCollectorItemsBefore);
const mockedListCollectorItemsAfter = vi.mocked(listBrainCollectorItemsAfter);
const mockedListCollectorItemsBySlugPrefix = vi.mocked(
  listBrainCollectorItemsBySlugPrefix,
);
beforeEach(() => {
  mockedListCollectorItemsBefore.mockReset();
  mockedListCollectorItemsBefore.mockResolvedValue([]);
  mockedListCollectorItemsAfter.mockReset();
  mockedListCollectorItemsAfter.mockResolvedValue([]);
  mockedListCollectorItemsBySlugPrefix.mockReset();
  mockedListCollectorItemsBySlugPrefix.mockResolvedValue([]);
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

  it('emits deterministic person and relation references from page metadata', () => {
    const identities: PersonIdentityRecord[] = [
      {
        userId: 'roomote-ada',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        role: 'member',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        deletedAt: null,
        providers: [],
      },
    ];
    const notionUsers: NotionUserIdentity[] = [
      { id: 'notion-ada', name: 'Ada', email: 'ada@example.com' },
      { id: 'notion-alex', name: 'Alex', email: null },
    ];
    const identityLookup = buildPersonIdentityLookup(identities);
    const users = buildNotionUserReferences(notionUsers, identityLookup);
    const canonical = identityLookup.get('ada@example.com')!;
    const mapped = buildNotionPage(
      {
        ...page,
        // Authorship fields carry partial users ({object, id} only); the
        // stored directory resolves them or they fall back to a stable id.
        created_by: { object: 'user', id: 'notion-ada' },
        last_edited_by: { object: 'user', id: 'unknown-user' },
        properties: {
          ...page.properties,
          Owners: {
            type: 'people',
            people: [
              { object: 'user', id: 'notion-ada' },
              { object: 'user', id: 'notion-alex' },
            ],
          },
          Summary: {
            type: 'rich_text',
            rich_text: [
              {
                type: 'mention',
                mention: {
                  type: 'user',
                  user: { object: 'user', id: 'notion-ada' },
                },
              },
            ],
          },
          Related: {
            type: 'relation',
            relation: [{ id: 'ABCDEF12-3456-7890-ABCD-EF1234567890' }],
          },
        },
      },
      { markdown: '# Body' },
      { identityContext: { users, identityLookup } },
    );

    expect(mapped?.content).toContain(
      `created_by: ${JSON.stringify(canonical.slug)}`,
    );
    expect(mapped?.content).toContain(
      'last_edited_by: "notion/user/unknownuser"',
    );
    expect(mapped?.content).toContain(
      `mentions: ${JSON.stringify([canonical.slug])}`,
    );
    expect(mapped?.content).toContain(users.get('notion-alex')!.slug);
    expect(mapped?.content).toContain(
      'relations: ["notion/abcdef1234567890abcdef1234567890"]',
    );
  });

  it('uses only verified inline emails for canonical reconciliation', () => {
    // Full user objects (with type/person.email) appear only in people
    // properties and rich-text mentions, never in created_by/last_edited_by,
    // which Notion returns as partial users.
    const canonical = {
      slug: 'people/roomote-member-ada',
      title: 'Ada',
    };
    const identityLookup = new Map([['ada@example.com', canonical]]);
    const withOwner = (user: Record<string, unknown>) => ({
      ...page,
      properties: {
        ...page.properties,
        Owners: { type: 'people', people: [user] },
      },
    });
    const verified = buildNotionPage(
      withOwner({
        object: 'user',
        id: 'verified-user',
        type: 'person',
        name: 'Ada',
        person: { email: 'ADA@EXAMPLE.COM', email_verified: true },
      }),
      {},
      { identityContext: { users: new Map(), identityLookup } },
    );
    const unverified = buildNotionPage(
      withOwner({
        object: 'user',
        id: 'unverified-user',
        type: 'person',
        name: 'Ada',
        person: { email: 'ada@example.com', email_verified: false },
      }),
      {},
      { identityContext: { users: new Map(), identityLookup } },
    );

    expect(verified?.content).toContain(
      'people: ["people/roomote-member-ada"]',
    );
    expect(unverified?.content).toContain(
      'people: ["notion/user/unverifieduser"]',
    );
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
    // A completed reconcile now hands off to the traversal phase, which
    // hunts pages Notion's search index never surfaced before going idle.
    expect(JSON.parse(result.stateUpdates?.[0]?.cursor ?? '{}')).toEqual({
      mode: 'traverse',
      lastSweepAt: '2026-08-15T00:00:00.000Z',
      scanStartedAt: '2026-08-15T00:00:00.000Z',
      traverse: { afterItemId: '', pending: [] },
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

describe('Notion traversal discovery', () => {
  const config = { token: 'secret' } as never;
  const itemRow = (itemId: string) => ({
    collectorId: 'notion-pages',
    itemId,
    slug: `notion/${itemId.replace(/-/g, '')}`,
    lastSeenAt: new Date('2026-08-27T00:00:00Z'),
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-27T00:00:00Z'),
  });
  const savedTraverse = {
    mode: 'traverse' as const,
    lastSweepAt: '2026-08-27T00:00:00.000Z',
    scanStartedAt: '2026-08-27T00:00:00.000Z',
    traverse: { afterItemId: '', pending: [] },
  };
  const pageObject = (id: string, title: string) => ({
    object: 'page',
    id,
    created_time: '2026-08-01T00:00:00.000Z',
    last_edited_time: '2026-08-02T00:00:00.000Z',
    properties: { Name: { type: 'title', title: [{ plain_text: title }] } },
  });

  it('discovers and ingests a child page absent from search results', async () => {
    const parent = 'aaaa1111-0000-0000-0000-000000000001';
    const child = 'eeee5555-0000-0000-0000-000000000002';
    mockedListCollectorItemsAfter
      .mockResolvedValueOnce([itemRow(parent)])
      .mockResolvedValue([]);
    // The child is unknown to the inventory (search never returned it).
    mockedListCollectorItemsBySlugPrefix.mockResolvedValue([]);
    mockNotionApiRequestJson.mockImplementation(async ({ path }) => {
      if (path === `blocks/${encodeURIComponent(parent)}/children`) {
        return {
          results: [{ object: 'block', id: child, type: 'child_page' }],
          has_more: false,
        };
      }
      if (path === `pages/${encodeURIComponent(child)}`) {
        return pageObject(child, 'Inherited incident page');
      }
      if (path === `pages/${encodeURIComponent(child)}/markdown`) {
        return { markdown: 'Postmortem body' };
      }
      if (path.startsWith('blocks/')) {
        return { results: [], has_more: false };
      }
      throw new Error(`unexpected path ${path}`);
    });

    const result = await collectNotionTraversal({
      config,
      saved: savedTraverse,
      limit: 10,
    });

    expect(result.pages.map((page) => page.title)).toEqual([
      'Inherited incident page',
    ]);
    expect(result.itemUpdates).toEqual([
      expect.objectContaining({
        collectorId: 'notion-pages',
        itemId: child,
        slug: 'notion/eeee5555000000000000000000000002',
      }),
    ]);
  });

  it('does not re-ingest a page the inventory already tracks', async () => {
    const parent = 'aaaa1111-0000-0000-0000-000000000001';
    const child = 'bbbb2222-0000-0000-0000-000000000002';
    mockedListCollectorItemsAfter
      .mockResolvedValueOnce([itemRow(parent)])
      .mockResolvedValue([]);
    // Search already found this child during the sweep.
    mockedListCollectorItemsBySlugPrefix.mockResolvedValue([itemRow(child)]);
    mockNotionApiRequestJson.mockImplementation(async ({ path }) => {
      if (path.startsWith('blocks/')) {
        return {
          results: [{ object: 'block', id: child, type: 'child_page' }],
          has_more: false,
        };
      }
      throw new Error(`unexpected page fetch ${path}`);
    });

    const result = await collectNotionTraversal({
      config,
      saved: savedTraverse,
      limit: 10,
    });

    expect(result.pages).toEqual([]);
    expect(
      mockNotionApiRequestJson.mock.calls.filter(([request]) =>
        (request as { path: string }).path.startsWith('pages/'),
      ),
    ).toHaveLength(0);
  });

  it('persists its cursor when the request budget ends a pass mid-tree', async () => {
    const parents = Array.from({ length: 25 }, (_, index) =>
      itemRow(
        `cccc3333-0000-0000-0000-0000000000${String(index).padStart(2, '0')}`,
      ),
    );
    mockedListCollectorItemsAfter.mockResolvedValueOnce(parents);
    mockNotionApiRequestJson.mockImplementation(async ({ path }) => {
      if (path.startsWith('blocks/')) {
        return { results: [], has_more: false };
      }
      throw new Error(`unexpected path ${path}`);
    });

    const result = await collectNotionTraversal({
      config,
      saved: savedTraverse,
      limit: 10,
    });

    const cursor = JSON.parse(result.stateUpdates![0]!.cursor as string) as {
      mode: string;
      traverse?: { afterItemId: string; pending: unknown[] };
    };
    // 12-request budget over 25 seeded parents: still traversing, with the
    // remaining parents carried in pending and the seed cursor advanced.
    expect(cursor.mode).toBe('traverse');
    expect(cursor.traverse!.pending.length).toBeGreaterThan(0);
    expect(cursor.traverse!.afterItemId).toBe(parents[24]!.itemId);
  });

  it('queries data sources behind child databases', async () => {
    const parent = 'dddd4444-0000-0000-0000-000000000001';
    const database = 'dddd4444-0000-0000-0000-0000000000db';
    const dataSource = 'dddd4444-0000-0000-0000-0000000000d5';
    const row = 'dddd4444-0000-0000-0000-00000000r0w1';
    mockedListCollectorItemsAfter
      .mockResolvedValueOnce([itemRow(parent)])
      .mockResolvedValue([]);
    mockedListCollectorItemsBySlugPrefix.mockResolvedValue([]);
    mockNotionApiRequestJson.mockImplementation(async ({ path }) => {
      if (path === `blocks/${encodeURIComponent(parent)}/children`) {
        return {
          results: [{ object: 'block', id: database, type: 'child_database' }],
          has_more: false,
        };
      }
      if (path === `databases/${encodeURIComponent(database)}`) {
        return { data_sources: [{ id: dataSource }] };
      }
      if (path === `data_sources/${encodeURIComponent(dataSource)}/query`) {
        return { results: [pageObject(row, 'Row page')], has_more: false };
      }
      if (path === `pages/${encodeURIComponent(row)}`) {
        return pageObject(row, 'Row page');
      }
      if (path === `pages/${encodeURIComponent(row)}/markdown`) {
        return { markdown: 'Row body' };
      }
      if (path.startsWith('blocks/')) {
        return { results: [], has_more: false };
      }
      throw new Error(`unexpected path ${path}`);
    });

    const result = await collectNotionTraversal({
      config,
      saved: savedTraverse,
      limit: 10,
    });

    expect(result.pages.map((page) => page.title)).toEqual(['Row page']);
  });

  it('descends into any block with children, not just a container allowlist', async () => {
    const parent = 'ffff6666-0000-0000-0000-000000000001';
    const paragraph = 'ffff6666-0000-0000-0000-0000000000b1';
    const child = 'ffff6666-0000-0000-0000-000000000002';
    mockedListCollectorItemsAfter
      .mockResolvedValueOnce([itemRow(parent)])
      .mockResolvedValue([]);
    mockedListCollectorItemsBySlugPrefix.mockResolvedValue([]);
    mockNotionApiRequestJson.mockImplementation(async ({ path }) => {
      if (path === `blocks/${encodeURIComponent(parent)}/children`) {
        // A child page hiding under an indented paragraph — a block type no
        // container allowlist would name.
        return {
          results: [
            {
              object: 'block',
              id: paragraph,
              type: 'paragraph',
              has_children: true,
            },
          ],
          has_more: false,
        };
      }
      if (path === `blocks/${encodeURIComponent(paragraph)}/children`) {
        return {
          results: [{ object: 'block', id: child, type: 'child_page' }],
          has_more: false,
        };
      }
      if (path === `pages/${encodeURIComponent(child)}`) {
        return pageObject(child, 'Indented child page');
      }
      if (path === `pages/${encodeURIComponent(child)}/markdown`) {
        return { markdown: 'Body' };
      }
      if (path.startsWith('blocks/')) {
        return { results: [], has_more: false };
      }
      throw new Error(`unexpected path ${path}`);
    });

    const result = await collectNotionTraversal({
      config,
      saved: savedTraverse,
      limit: 10,
    });

    expect(result.pages.map((page) => page.title)).toEqual([
      'Indented child page',
    ]);
  });

  it('stops mid-response at the request budget instead of overshooting', async () => {
    const parent = 'aaaa7777-0000-0000-0000-000000000001';
    const children = Array.from(
      { length: 40 },
      (_, index) =>
        `aaaa7777-0000-0000-0000-0000000001${String(index).padStart(2, '0')}`,
    );
    mockedListCollectorItemsAfter
      .mockResolvedValueOnce([itemRow(parent)])
      .mockResolvedValue([]);
    mockedListCollectorItemsBySlugPrefix.mockResolvedValue([]);
    mockNotionApiRequestJson.mockImplementation(async ({ path }) => {
      if (path === `blocks/${encodeURIComponent(parent)}/children`) {
        return {
          results: children.map((id) => ({
            object: 'block',
            id,
            type: 'child_page',
          })),
          has_more: false,
        };
      }
      const pageMatch = /^pages\/([^/]+)$/.exec(path);
      if (pageMatch) {
        return pageObject(decodeURIComponent(pageMatch[1]!), 'Bulk child');
      }
      if (path.endsWith('/markdown')) {
        return { markdown: 'Body' };
      }
      if (path.startsWith('blocks/')) {
        return { results: [], has_more: false };
      }
      throw new Error(`unexpected path ${path}`);
    });

    const result = await collectNotionTraversal({
      config,
      saved: savedTraverse,
      limit: 100,
    });

    // 12-request budget: 1 list + 5 ingests (2 requests each) = 11; the
    // sixth candidate must not start. No page overshoot, and the node
    // re-queues with the same cursor so the retry resumes exactly here.
    expect(mockNotionApiRequestJson.mock.calls.length).toBeLessThanOrEqual(12);
    expect(result.pages.length).toBeLessThanOrEqual(6);
    const cursor = JSON.parse(result.stateUpdates![0]!.cursor as string) as {
      mode: string;
      traverse?: { pending: { kind: string; id: string }[] };
    };
    expect(cursor.mode).toBe('traverse');
    expect(
      cursor.traverse!.pending.some(
        (node) => node.kind === 'blocks' && node.id === parent,
      ),
    ).toBe(true);
  });

  it('caps emitted pages at the collector limit', async () => {
    const parent = 'bbbb8888-0000-0000-0000-000000000001';
    const children = [
      'bbbb8888-0000-0000-0000-000000000101',
      'bbbb8888-0000-0000-0000-000000000102',
      'bbbb8888-0000-0000-0000-000000000103',
    ];
    mockedListCollectorItemsAfter
      .mockResolvedValueOnce([itemRow(parent)])
      .mockResolvedValue([]);
    mockedListCollectorItemsBySlugPrefix.mockResolvedValue([]);
    mockNotionApiRequestJson.mockImplementation(async ({ path }) => {
      if (path === `blocks/${encodeURIComponent(parent)}/children`) {
        return {
          results: children.map((id) => ({
            object: 'block',
            id,
            type: 'child_page',
          })),
          has_more: false,
        };
      }
      const pageMatch = /^pages\/([^/]+)$/.exec(path);
      if (pageMatch) {
        return pageObject(decodeURIComponent(pageMatch[1]!), 'Limited child');
      }
      if (path.endsWith('/markdown')) {
        return { markdown: 'Body' };
      }
      if (path.startsWith('blocks/')) {
        return { results: [], has_more: false };
      }
      throw new Error(`unexpected path ${path}`);
    });

    const result = await collectNotionTraversal({
      config,
      saved: savedTraverse,
      limit: 2,
    });

    expect(result.pages).toHaveLength(2);
    expect(JSON.parse(result.stateUpdates![0]!.cursor as string)).toMatchObject(
      { mode: 'traverse' },
    );
  });

  it('completes back to idle when the inventory is exhausted', async () => {
    mockedListCollectorItemsAfter.mockResolvedValue([]);

    const result = await collectNotionTraversal({
      config,
      saved: savedTraverse,
      limit: 10,
    });

    expect(result.pages).toEqual([]);
    expect(JSON.parse(result.stateUpdates![0]!.cursor as string)).toMatchObject(
      { mode: 'idle', lastSweepAt: '2026-08-27T00:00:00.000Z' },
    );
  });
});
