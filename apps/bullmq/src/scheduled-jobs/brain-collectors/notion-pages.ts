import {
  and,
  db,
  deploymentMcpEnablements,
  eq,
  getBrainSyncState,
  isNull,
  listBrainCollectorItems,
  listBrainCollectorItemsBefore,
  mcpConnections,
} from '@roomote/db/server';
import {
  NotionApiError,
  notionApiRequestJson,
} from '@roomote/sdk/server/notion-api';
import {
  isMcpConnectionNotionConfig,
  type McpConnectionNotionConfig,
} from '@roomote/types';

import type {
  BrainCollector,
  CollectorItemUpdate,
  CollectorPage,
  CollectorResult,
} from './contracts';
import { asString, formatUtcDay, parseDate } from './shared';

/**
 * Notion: pages shared with the deployment integration
 * -----------------------------------------------------
 *
 * Notion's search API enumerates only content explicitly shared with the
 * stored internal integration. Its first-party page-as-Markdown endpoint
 * supplies the complete agent-friendly body without maintaining a second
 * block renderer here. Search is newest-first, with durable cursors for both
 * the initial backfill and incremental scans.
 */

const NOTION_PAGES_COLLECTOR_ID = 'notion-pages';
const NOTION_INCREMENTAL_STATE_ID = `${NOTION_PAGES_COLLECTOR_ID}:incremental`;
const NOTION_SEARCH_PAGE_SIZE = 20;
const NOTION_FULL_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const NOTION_REQUEST_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 0 : 350;
const NOTION_MAX_SEARCH_REQUESTS_PER_PASS = 10;

let notionRequestAvailableAt = 0;

type NotionCollectorRequest = {
  config: McpConnectionNotionConfig;
  path: string;
  method?: 'GET' | 'POST' | 'PATCH';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};

async function waitForNotionRequestSlot(): Promise<void> {
  const waitMs = Math.max(0, notionRequestAvailableAt - Date.now());
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  notionRequestAvailableAt = Date.now() + NOTION_REQUEST_INTERVAL_MS;
}

async function notionCollectorRequest<T>(
  request: NotionCollectorRequest,
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await waitForNotionRequestSlot();
    try {
      return await notionApiRequestJson<T>(request);
    } catch (error) {
      if (!(error instanceof NotionApiError) || error.status !== 429) {
        throw error;
      }
      if (attempt === 1) {
        throw error;
      }
      notionRequestAvailableAt =
        Date.now() +
        Math.max(
          NOTION_REQUEST_INTERVAL_MS,
          (error.retryAfterSeconds ?? 1) * 1000,
        );
    }
  }

  throw new Error('Notion request retry loop ended unexpectedly');
}

export type NotionSearchPage = {
  object: 'page';
  id: string;
  created_time?: string;
  last_edited_time?: string;
  in_trash?: boolean;
  url?: string;
  properties?: Record<string, unknown>;
};

type NotionSearchResponse = {
  results?: unknown[];
  has_more?: boolean;
  next_cursor?: string | null;
};

type NotionMarkdownResponse = {
  markdown?: string;
  truncated?: boolean;
  unknown_block_ids?: string[];
};

function isNotionSearchPage(value: unknown): value is NotionSearchPage {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as Record<string, unknown>).object === 'page' &&
    asString((value as Record<string, unknown>).id),
  );
}

function notionRichTextPlainText(value: unknown): string {
  if (!Array.isArray(value)) {
    return '';
  }

  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return '';
      }
      const record = entry as Record<string, unknown>;
      const text =
        record.text && typeof record.text === 'object'
          ? asString((record.text as Record<string, unknown>).content)
          : null;
      return asString(record.plain_text) ?? text ?? '';
    })
    .join('')
    .trim();
}

function notionPageTitle(page: NotionSearchPage): string {
  for (const property of Object.values(page.properties ?? {})) {
    if (!property || typeof property !== 'object') {
      continue;
    }
    const record = property as Record<string, unknown>;
    if (record.type === 'title') {
      const title = notionRichTextPlainText(record.title);
      if (title) {
        return title;
      }
    }
  }

  return 'Untitled Notion page';
}

export function buildNotionPage(
  page: NotionSearchPage,
  markdown: NotionMarkdownResponse,
  status: 'active' | 'deleted' | 'unavailable' = page.in_trash
    ? 'deleted'
    : 'active',
): CollectorPage | null {
  const pageId = asString(page.id);
  if (!pageId) {
    return null;
  }
  const slug = notionPageSlug(pageId);
  if (!slug) {
    return null;
  }

  const title = notionPageTitle(page);
  const createdAt = parseDate(page.created_time);
  const updatedAt = parseDate(page.last_edited_time) ?? createdAt;
  const sourceUrl = asString(page.url);
  const body = asString(markdown.markdown);

  return {
    slug,
    title,
    content: [
      '---',
      'type: notion-page',
      `notion_page_id: ${JSON.stringify(pageId)}`,
      `status: ${status}`,
      'provenance: roomote-notion',
      ...(updatedAt ? [`date: ${formatUtcDay(updatedAt)}`] : []),
      ...(createdAt ? [`created_at: ${createdAt.toISOString()}`] : []),
      ...(updatedAt ? [`last_edited_at: ${updatedAt.toISOString()}`] : []),
      ...(sourceUrl ? [`source_url: ${JSON.stringify(sourceUrl)}`] : []),
      '---',
      '',
      `# ${title}`,
      ...(sourceUrl ? ['', `[Open in Notion](${sourceUrl})`] : []),
      ...(status === 'deleted'
        ? ['', 'This page is in the Notion trash.']
        : status === 'unavailable'
          ? ['', 'This page is no longer available to the Notion integration.']
          : body
            ? ['', body]
            : []),
      ...(markdown.truncated
        ? [
            '',
            '_Notion truncated this Markdown snapshot; open the source page for the omitted content._',
          ]
        : []),
      '',
    ].join('\n'),
  };
}

function notionPageSlug(pageId: string): string | null {
  const stableId = pageId.toLowerCase().replace(/[^a-z0-9]/g, '');
  return stableId ? `notion/${stableId}` : null;
}

async function findNotionConnectionConfig(): Promise<McpConnectionNotionConfig | null> {
  const [connection, enablement] = await Promise.all([
    db.query.mcpConnections.findFirst({
      where: and(
        eq(mcpConnections.mcpId, 'notion'),
        isNull(mcpConnections.userId),
        eq(mcpConnections.enabled, true),
        eq(mcpConnections.authStatus, 'authenticated'),
      ),
    }),
    db.query.deploymentMcpEnablements.findFirst({
      where: and(
        eq(deploymentMcpEnablements.mcpId, 'notion'),
        eq(deploymentMcpEnablements.enabled, true),
      ),
      columns: { mcpId: true },
    }),
  ]);

  return enablement && isMcpConnectionNotionConfig(connection?.authConfig)
    ? connection.authConfig
    : null;
}

async function searchNotionPages(input: {
  config: McpConnectionNotionConfig;
  cursor: string | null;
  pageSize: number;
}): Promise<{
  pages: NotionSearchPage[];
  nextCursor: string | null;
}> {
  const response = await notionCollectorRequest<NotionSearchResponse>({
    config: input.config,
    path: 'search',
    method: 'POST',
    body: buildNotionSearchBody(input.cursor, input.pageSize),
  });

  return {
    pages: (response.results ?? []).filter(isNotionSearchPage),
    nextCursor:
      response.has_more && asString(response.next_cursor)
        ? response.next_cursor!.trim()
        : null,
  };
}

export function buildNotionSearchBody(
  cursor: string | null,
  pageSize: number,
): Record<string, unknown> {
  return {
    filter: { property: 'object', value: 'page' },
    sort: { direction: 'descending', timestamp: 'last_edited_time' },
    page_size: Math.min(Math.max(1, pageSize), NOTION_SEARCH_PAGE_SIZE),
    ...(cursor ? { start_cursor: cursor } : {}),
  };
}

async function fetchNotionPage(
  config: McpConnectionNotionConfig,
  page: NotionSearchPage,
  unavailableOnNotFound = true,
): Promise<CollectorPage | null> {
  if (page.in_trash) {
    return buildNotionPage(page, {});
  }

  try {
    const markdown = await notionCollectorRequest<NotionMarkdownResponse>({
      config,
      path: `pages/${encodeURIComponent(page.id)}/markdown`,
    });
    return buildNotionPage(page, markdown);
  } catch (error) {
    if (
      unavailableOnNotFound &&
      error instanceof NotionApiError &&
      error.status === 404
    ) {
      return buildNotionPage(page, {}, 'unavailable');
    }
    throw error;
  }
}

type NotionScanCursor = {
  mode: 'idle' | 'incremental' | 'sweep' | 'reconcile';
  lastSweepAt: string | null;
  upstreamCursor?: string;
  since?: string;
  scanStartedAt?: string;
};

function parseNotionScanCursor(raw: string | null): NotionScanCursor {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<NotionScanCursor>;
      if (
        parsed.mode === 'idle' ||
        parsed.mode === 'incremental' ||
        parsed.mode === 'sweep' ||
        parsed.mode === 'reconcile'
      ) {
        return {
          mode: parsed.mode,
          lastSweepAt:
            typeof parsed.lastSweepAt === 'string' ? parsed.lastSweepAt : null,
          ...(typeof parsed.upstreamCursor === 'string'
            ? { upstreamCursor: parsed.upstreamCursor }
            : {}),
          ...(typeof parsed.since === 'string' ? { since: parsed.since } : {}),
          ...(typeof parsed.scanStartedAt === 'string'
            ? { scanStartedAt: parsed.scanStartedAt }
            : {}),
        };
      }
    } catch {
      // Restart with a full sweep when durable cursor JSON is unreadable.
    }
  }

  return { mode: 'sweep', lastSweepAt: null };
}

function serializeNotionScanCursor(cursor: NotionScanCursor): string {
  return JSON.stringify(cursor);
}

function notionItemUpdate(
  page: NotionSearchPage,
  slug: string,
  lastSeenAt: Date,
): CollectorItemUpdate {
  return {
    collectorId: NOTION_PAGES_COLLECTOR_ID,
    itemId: page.id,
    slug,
    lastSeenAt,
  };
}

export function buildNotionSweepInventory(
  pages: NotionSearchPage[],
  scanStartedAt: Date,
): CollectorItemUpdate[] {
  return pages.flatMap((page) => {
    const slug = notionPageSlug(page.id);
    return slug ? [notionItemUpdate(page, slug, scanStartedAt)] : [];
  });
}

export function buildUnavailableNotionPage(item: {
  itemId: string;
  slug: string;
}): CollectorPage {
  const page = buildNotionPage(
    { object: 'page', id: item.itemId },
    {},
    'unavailable',
  );

  return {
    slug: item.slug,
    title: page?.title ?? 'Unavailable Notion page',
    content:
      page?.content ??
      `---\ntype: notion-page\nstatus: unavailable\nprovenance: roomote-notion\n---\n\n# Unavailable Notion page\n\nThis page is no longer available to the Notion integration.\n`,
  };
}

export async function collectNotionReconciliation(input: {
  config: McpConnectionNotionConfig;
  saved: NotionScanCursor;
  limit: number;
}): Promise<CollectorResult> {
  const scanStartedAt = parseDate(input.saved.scanStartedAt) ?? new Date(0);
  const stale = await listBrainCollectorItemsBefore(
    db,
    NOTION_PAGES_COLLECTOR_ID,
    scanStartedAt,
    input.limit + 1,
  );
  const batch = stale.slice(0, input.limit);
  const complete = stale.length <= input.limit;
  const pages: CollectorPage[] = [];
  const itemUpdates: CollectorItemUpdate[] = [];
  const itemIdsToDelete: string[] = [];

  for (const item of batch) {
    try {
      const page = await notionCollectorRequest<unknown>({
        config: input.config,
        path: `pages/${encodeURIComponent(item.itemId)}`,
      });
      if (!isNotionSearchPage(page)) {
        throw new Error(
          `Notion returned an invalid page object for ${item.itemId}`,
        );
      }
      const mapped = await fetchNotionPage(input.config, page, false);
      if (mapped) {
        pages.push(mapped);
        itemUpdates.push(notionItemUpdate(page, mapped.slug, scanStartedAt));
      }
    } catch (error) {
      if (!(error instanceof NotionApiError) || error.status !== 404) {
        throw error;
      }
      pages.push(buildUnavailableNotionPage(item));
      itemIdsToDelete.push(item.itemId);
    }
  }

  return {
    pages,
    nextSince: null,
    itemUpdates,
    itemDeletes: [
      {
        collectorId: NOTION_PAGES_COLLECTOR_ID,
        itemIds: itemIdsToDelete,
      },
    ],
    stateUpdates: [
      {
        collectorId: NOTION_INCREMENTAL_STATE_ID,
        ...(complete ? { watermark: scanStartedAt } : {}),
        cursor: serializeNotionScanCursor(
          complete
            ? {
                mode: 'idle',
                lastSweepAt: scanStartedAt.toISOString(),
              }
            : {
                mode: 'reconcile',
                lastSweepAt: input.saved.lastSweepAt,
                scanStartedAt: scanStartedAt.toISOString(),
              },
        ),
      },
    ],
  };
}

async function collectDisabledNotionPages(
  limit: number,
): Promise<CollectorResult> {
  const tracked = await listBrainCollectorItems(
    db,
    NOTION_PAGES_COLLECTOR_ID,
    limit + 1,
  );
  const batch = tracked.slice(0, limit);
  const complete = tracked.length <= limit;

  return {
    pages: batch.map(buildUnavailableNotionPage),
    nextSince: null,
    itemDeletes: [
      {
        collectorId: NOTION_PAGES_COLLECTOR_ID,
        itemIds: batch.map((item) => item.itemId),
      },
    ],
    ...(complete
      ? {
          stateUpdates: [
            {
              collectorId: NOTION_PAGES_COLLECTOR_ID,
              cursor: null,
              backfillCompletedAt: null,
            },
            {
              collectorId: NOTION_INCREMENTAL_STATE_ID,
              cursor: serializeNotionScanCursor({
                mode: 'sweep',
                lastSweepAt: null,
              }),
            },
          ],
        }
      : {}),
  };
}

async function collectNotionPages(input: {
  config: McpConnectionNotionConfig;
  now: Date;
  limit: number;
}): Promise<CollectorResult> {
  const [collectorState, state] = await Promise.all([
    getBrainSyncState(db, NOTION_PAGES_COLLECTOR_ID),
    getBrainSyncState(db, NOTION_INCREMENTAL_STATE_ID),
  ]);

  // Establish the incremental boundary before the newest-first backfill. Any
  // edit made while backfill runs is then picked up after backfill completes.
  if (!collectorState?.backfillCompletedAt) {
    if (state) {
      return { pages: [], nextSince: null };
    }
    return {
      pages: [],
      nextSince: null,
      stateUpdates: [
        {
          collectorId: NOTION_INCREMENTAL_STATE_ID,
          watermark: input.now,
          cursor: serializeNotionScanCursor({
            mode: 'idle',
            lastSweepAt: null,
          }),
        },
      ],
    };
  }

  const saved = parseNotionScanCursor(state?.backfillCursor ?? null);
  if (saved.mode === 'reconcile') {
    return collectNotionReconciliation({
      config: input.config,
      saved,
      limit: input.limit,
    });
  }
  const savedSweepAt = saved.lastSweepAt ? parseDate(saved.lastSweepAt) : null;
  const continuing = saved.mode === 'incremental' || saved.mode === 'sweep';
  const mode: 'incremental' | 'sweep' = continuing
    ? saved.mode === 'sweep'
      ? 'sweep'
      : 'incremental'
    : !savedSweepAt ||
        input.now.getTime() - savedSweepAt.getTime() >=
          NOTION_FULL_SWEEP_INTERVAL_MS
      ? 'sweep'
      : 'incremental';
  const since = continuing
    ? (parseDate(saved.since) ?? new Date(0))
    : mode === 'sweep'
      ? new Date(0)
      : (state?.watermark ?? new Date(0));
  const scanStartedAt = continuing
    ? (parseDate(saved.scanStartedAt) ?? input.now)
    : input.now;
  let upstreamCursor = continuing ? (saved.upstreamCursor ?? null) : null;
  const pages: CollectorPage[] = [];
  const itemUpdates: CollectorItemUpdate[] = [];
  let searchRequests = 0;
  let complete = false;

  while (
    pages.length < input.limit &&
    searchRequests < NOTION_MAX_SEARCH_REQUESTS_PER_PASS
  ) {
    const batch = await searchNotionPages({
      config: input.config,
      cursor: upstreamCursor,
      pageSize: Math.max(1, input.limit - pages.length),
    });
    searchRequests++;

    if (mode === 'sweep') {
      itemUpdates.push(
        ...buildNotionSweepInventory(batch.pages, scanStartedAt),
      );
    }

    const candidates = batch.pages.filter((page) => {
      const updatedAt = parseDate(page.last_edited_time);
      if (!updatedAt || updatedAt > scanStartedAt) {
        return false;
      }
      return mode === 'sweep' || updatedAt > since;
    });
    const reachedWatermark =
      mode === 'incremental' &&
      batch.pages.some((page) => {
        const updatedAt = parseDate(page.last_edited_time);
        return updatedAt ? updatedAt <= since : false;
      });

    for (const page of candidates) {
      const mapped = await fetchNotionPage(input.config, page);
      if (mapped) {
        pages.push(mapped);
        if (mode === 'incremental') {
          itemUpdates.push(notionItemUpdate(page, mapped.slug, input.now));
        }
      }
    }

    upstreamCursor = batch.nextCursor;
    if (reachedWatermark || !upstreamCursor) {
      complete = true;
      break;
    }
  }

  return {
    pages,
    nextSince: null,
    itemUpdates,
    stateUpdates: [
      {
        collectorId: NOTION_INCREMENTAL_STATE_ID,
        ...(complete ? { watermark: scanStartedAt } : {}),
        cursor: serializeNotionScanCursor(
          complete
            ? mode === 'sweep'
              ? {
                  mode: 'reconcile',
                  lastSweepAt: saved.lastSweepAt,
                  scanStartedAt: scanStartedAt.toISOString(),
                }
              : { mode: 'idle', lastSweepAt: saved.lastSweepAt }
            : {
                mode,
                lastSweepAt: saved.lastSweepAt,
                upstreamCursor: upstreamCursor ?? undefined,
                since: since.toISOString(),
                scanStartedAt: scanStartedAt.toISOString(),
              },
        ),
      },
    ],
  };
}

async function backfillNotionPagesStep(
  config: McpConnectionNotionConfig,
  cursor: string | null,
  limit: number,
): Promise<{
  pages: CollectorPage[];
  nextCursor: string | null;
  done: boolean;
  itemUpdates: CollectorItemUpdate[];
}> {
  const batch = await searchNotionPages({
    config,
    cursor,
    pageSize: Math.max(1, limit),
  });
  const pages: CollectorPage[] = [];
  const itemUpdates: CollectorItemUpdate[] = [];
  const observedAt = new Date();

  for (const page of batch.pages) {
    const mapped = await fetchNotionPage(config, page);
    if (mapped) {
      pages.push(mapped);
      itemUpdates.push(notionItemUpdate(page, mapped.slug, observedAt));
    }
  }

  return {
    pages,
    nextCursor: batch.nextCursor,
    done: batch.nextCursor === null,
    itemUpdates,
  };
}

export const notionPagesCollector: BrainCollector = {
  id: NOTION_PAGES_COLLECTOR_ID,
  displayName: 'Notion pages',
  async isEnabled() {
    const [config, tracked] = await Promise.all([
      findNotionConnectionConfig(),
      listBrainCollectorItems(db, NOTION_PAGES_COLLECTOR_ID, 1),
    ]);
    return Boolean(config || tracked.length > 0);
  },
  async collect({ now, limit }) {
    const config = await findNotionConnectionConfig();
    return config
      ? collectNotionPages({ config, now, limit })
      : collectDisabledNotionPages(limit);
  },
  async backfill({ cursor, limit }) {
    const config = await findNotionConnectionConfig();
    return config
      ? backfillNotionPagesStep(config, cursor, limit)
      : { pages: [], nextCursor: cursor, done: false };
  },
};
