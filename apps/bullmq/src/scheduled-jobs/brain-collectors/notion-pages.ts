import { createHash } from 'node:crypto';

import {
  and,
  db,
  eq,
  getBrainSyncState,
  listBrainCollectorItems,
  listBrainCollectorItemsAfter,
  listBrainCollectorItemsBefore,
  listBrainCollectorItemsBySlugPrefix,
  lt,
  notionDirectoryUsers,
} from '@roomote/db/server';
import {
  findBrainSourceConnectionConfig,
  isBrainSourceAvailable,
} from '@roomote/sdk/server';
import {
  NotionApiError,
  notionApiRequestJson,
} from '@roomote/sdk/server/notion-api';
import {
  BRAIN_COLLECTOR_IDS,
  BRAIN_PAGE_TYPES,
  brainNamespacePrefix,
  renderBrainFrontmatter,
  type McpConnectionNotionConfig,
} from '@roomote/types';

import type {
  BrainCollector,
  CollectorItemUpdate,
  CollectorPage,
  CollectorResult,
  CollectorStateUpdate,
} from './contracts';
import {
  brainSafeIdentityValue,
  hashedPeopleSlug,
  normalizeIdentityAlias,
  type PersonIdentityReference,
} from './identity';
import {
  buildPersonIdentityLookup,
  loadPersonIdentityRecords,
  selectSweepSlice,
} from './person-identities';
import { asObject, asString, formatUtcDay, parseDate } from './shared';

const LOG_PREFIX = '[brainCollectors]';

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

const NOTION_PAGES_COLLECTOR_ID = BRAIN_COLLECTOR_IDS.notionPages;
const NOTION_INCREMENTAL_STATE_ID = `${NOTION_PAGES_COLLECTOR_ID}:incremental`;
const NOTION_USERS_COLLECTOR_ID = 'notion-users';
const NOTION_USERS_REFRESH_STATE_ID = `${NOTION_USERS_COLLECTOR_ID}:refresh`;
const NOTION_SEARCH_PAGE_SIZE = 20;
const NOTION_USERS_PAGE_SIZE = 100;
const NOTION_USERS_REFRESH_MS = 24 * 60 * 60 * 1000;
/** Bound per-tick /users pagination; longer directories continue next tick. */
const NOTION_USERS_MAX_REQUESTS_PER_PASS = 5;
const NOTION_FULL_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const NOTION_REQUEST_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 0 : 350;
const NOTION_MAX_SEARCH_REQUESTS_PER_PASS = 10;
/**
 * Traversal phase budgets. Notion's search API is documented as not
 * guaranteed to return everything the integration can access — only
 * directly-shared content is guaranteed; children reachable through a shared
 * parent may never appear (see
 * https://developers.notion.com/reference/search-optimizations-and-limitations).
 * After each sweep+reconcile cycle the collector therefore walks the block
 * tree and data sources of every inventoried page, discovering
 * inheritance-shared pages the search index missed.
 */
const NOTION_MAX_TRAVERSAL_REQUESTS_PER_PASS = 24;
const NOTION_TRAVERSAL_SEED_BATCH = 25;
const NOTION_TRAVERSAL_BLOCK_PAGE_SIZE = 100;
const NOTION_TRAVERSAL_QUERY_PAGE_SIZE = 50;
/** Block-container nesting to follow (toggles, columns) below a page. */
const NOTION_TRAVERSAL_MAX_BLOCK_DEPTH = 3;
/**
 * Ceiling on carried-over traversal work between passes. The seed side needs
 * no queue (it iterates the inventory by durable id cursor); this bounds only
 * discovered-but-unexpanded containers, and dropping past the cap trades a
 * deeper corner of the tree for a bounded cursor row — logged, never silent.
 */
const NOTION_TRAVERSAL_MAX_PENDING = 300;

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
  created_by?: unknown;
  last_edited_by?: unknown;
  properties?: Record<string, unknown>;
};

export type NotionUserIdentity = {
  id: string;
  name: string;
  email: string | null;
};

type NotionUserReference = {
  slug: string;
  title: string;
  canonical: PersonIdentityReference | null;
};

type NotionUsersResponse = {
  results?: unknown[];
  has_more?: boolean;
  next_cursor?: string | null;
};

export function parseNotionUser(value: unknown): NotionUserIdentity | null {
  const record = asObject(value);
  const id = record ? asString(record.id) : null;
  if (!record || !id || record.object !== 'user' || record.type !== 'person') {
    return null;
  }

  const person = asObject(record.person);
  const emailVerified =
    record.email_verified === true || person?.email_verified === true;
  const email = emailVerified ? asString(person?.email) : null;

  return {
    id,
    name: brainSafeIdentityValue(asString(record.name) ?? '') || 'Notion user',
    email: email ? normalizeIdentityAlias(email) : null,
  };
}

type NotionDirectoryUser = NotionUserIdentity & { deleted: boolean };

/**
 * The durable directory snapshot is the only source consumed by projections.
 * The live /users API is read exclusively by refreshNotionUserDirectory, so
 * Notion outages and permission changes can never abort or flap the person
 * and page collectors.
 */
async function loadNotionDirectory(): Promise<NotionDirectoryUser[]> {
  const rows = await db.select().from(notionDirectoryUsers);

  return rows
    .map((row) => ({
      id: row.notionUserId,
      name: row.name,
      // A retracted row's email must stop linking canonical identities.
      email: row.isDeleted ? null : row.email,
      deleted: row.isDeleted,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

async function persistNotionDirectoryUsers(
  users: NotionUserIdentity[],
  now: Date,
): Promise<void> {
  for (const user of users) {
    await db
      .insert(notionDirectoryUsers)
      .values({
        notionUserId: user.id,
        name: user.name,
        email: user.email,
        isDeleted: false,
        lastSeenAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [notionDirectoryUsers.notionUserId],
        set: {
          name: user.name,
          email: user.email,
          isDeleted: false,
          lastSeenAt: now,
          updatedAt: now,
        },
      });
  }
}

/** Mark rows unseen since `before` (or every live row) as deleted. */
async function tombstoneNotionDirectoryUsers(
  before: Date | null,
  now: Date,
): Promise<void> {
  await db
    .update(notionDirectoryUsers)
    .set({ isDeleted: true, updatedAt: now })
    .where(
      before
        ? and(
            eq(notionDirectoryUsers.isDeleted, false),
            lt(notionDirectoryUsers.lastSeenAt, before),
          )
        : eq(notionDirectoryUsers.isDeleted, false),
    );
}

type NotionUsersRefreshCursor = {
  notionCursor: string;
  sweepStartedAt: string;
};

function parseNotionUsersRefreshCursor(
  raw: string | null,
): NotionUsersRefreshCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<NotionUsersRefreshCursor>;
    return typeof parsed.notionCursor === 'string' &&
      typeof parsed.sweepStartedAt === 'string'
      ? {
          notionCursor: parsed.notionCursor,
          sweepStartedAt: parsed.sweepStartedAt,
        }
      : null;
  } catch {
    return null;
  }
}

/**
 * Refresh the durable directory from GET /users on a daily cadence, paging a
 * bounded number of requests per tick. Failure semantics: 403 (integration
 * has no user-information capability) retracts the directory; a stale-cursor
 * 400 restarts the sweep; anything else keeps the stored directory untouched
 * and retries next tick.
 */
async function refreshNotionUserDirectory(input: {
  config: McpConnectionNotionConfig;
  state: { watermark: Date | null; backfillCursor: string | null } | null;
  now: Date;
}): Promise<CollectorStateUpdate | null> {
  const saved = parseNotionUsersRefreshCursor(
    input.state?.backfillCursor ?? null,
  );
  const refreshDue =
    !input.state?.watermark ||
    input.now.getTime() - input.state.watermark.getTime() >=
      NOTION_USERS_REFRESH_MS;
  if (!saved && !refreshDue) {
    return null;
  }

  const sweepStartedAt = saved
    ? (parseDate(saved.sweepStartedAt) ?? input.now)
    : input.now;
  let cursor = saved?.notionCursor ?? null;

  try {
    for (
      let requests = 0;
      requests < NOTION_USERS_MAX_REQUESTS_PER_PASS;
      requests++
    ) {
      const response = await notionCollectorRequest<NotionUsersResponse>({
        config: input.config,
        path: 'users',
        query: {
          page_size: NOTION_USERS_PAGE_SIZE,
          start_cursor: cursor ?? undefined,
        },
      });
      await persistNotionDirectoryUsers(
        (response.results ?? [])
          .map(parseNotionUser)
          .filter((user): user is NotionUserIdentity => Boolean(user)),
        input.now,
      );
      const nextCursor =
        response.has_more && asString(response.next_cursor)
          ? response.next_cursor!.trim()
          : null;
      if (!nextCursor) {
        await tombstoneNotionDirectoryUsers(sweepStartedAt, input.now);
        return {
          collectorId: NOTION_USERS_REFRESH_STATE_ID,
          watermark: input.now,
          cursor: null,
        };
      }
      cursor = nextCursor;
    }

    return {
      collectorId: NOTION_USERS_REFRESH_STATE_ID,
      cursor: JSON.stringify({
        notionCursor: cursor!,
        sweepStartedAt: sweepStartedAt.toISOString(),
      } satisfies NotionUsersRefreshCursor),
    };
  } catch (error) {
    if (error instanceof NotionApiError && error.status === 403) {
      await tombstoneNotionDirectoryUsers(null, input.now);
      return {
        collectorId: NOTION_USERS_REFRESH_STATE_ID,
        watermark: input.now,
        cursor: null,
      };
    }
    if (saved && error instanceof NotionApiError && error.status === 400) {
      // Notion pagination cursors expire; restart the sweep from the top.
      return { collectorId: NOTION_USERS_REFRESH_STATE_ID, cursor: null };
    }
    console.warn(
      `${LOG_PREFIX} notion user directory refresh failed; keeping the stored directory: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function notionUserSlug(userId: string): string {
  return hashedPeopleSlug('notion-user', `notion:${userId}`);
}

function notionQualifiedUserId(userId: string): string {
  return `notion/user/${userId.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
}

export function buildNotionUserReferences(
  users: NotionUserIdentity[],
  identities: ReadonlyMap<string, PersonIdentityReference>,
): Map<string, NotionUserReference> {
  return new Map(
    users.map((user) => {
      const canonical = user.email
        ? (identities.get(normalizeIdentityAlias(user.email)) ?? null)
        : null;
      return [
        user.id,
        {
          slug: canonical?.slug ?? notionUserSlug(user.id),
          title: canonical?.title ?? user.name,
          canonical,
        },
      ];
    }),
  );
}

export function buildNotionUserPage(
  user: NotionUserIdentity & { deleted?: boolean },
  reference: NotionUserReference,
): CollectorPage {
  const providerId = notionQualifiedUserId(user.id);
  const deleted = user.deleted === true;
  const canonical = deleted ? null : reference.canonical;
  return {
    slug: notionUserSlug(user.id),
    title: user.name,
    content: [
      ...renderBrainFrontmatter({
        type: canonical
          ? BRAIN_PAGE_TYPES.personAlias
          : BRAIN_PAGE_TYPES.person,
        title: user.name,
        fields: [
          `notion_user_id: ${JSON.stringify(user.id)}`,
          ...(canonical
            ? [`canonical: ${JSON.stringify(canonical.slug)}`]
            : [
                `aliases: ${JSON.stringify(deleted ? [] : [user.id, providerId])}`,
                `status: ${deleted ? 'deleted' : 'active'}`,
              ]),
          'provenance: roomote-notion-users',
        ],
      }),
      '',
      `# ${user.name}`,
      '',
      canonical
        ? `Notion identity for [${canonical.title}](${canonical.slug}).`
        : deleted
          ? 'This person is no longer a member of the Notion workspace.'
          : 'Notion workspace user.',
      '',
    ].join('\n'),
  };
}

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

type NotionPageIdentityContext = {
  users: ReadonlyMap<string, NotionUserReference>;
  identityLookup: ReadonlyMap<string, PersonIdentityReference>;
};

const EMPTY_NOTION_PAGE_IDENTITY_CONTEXT: NotionPageIdentityContext = {
  users: new Map(),
  identityLookup: new Map(),
};

function notionUserId(value: unknown): string | null {
  const record = asObject(value);
  return record ? asString(record.id) : null;
}

function notionRichTextUsers(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const mention = asObject(asObject(entry)?.mention);
    return mention?.type === 'user' && mention.user ? [mention.user] : [];
  });
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function resolveNotionUserReference(
  value: unknown,
  context: NotionPageIdentityContext,
): string | null {
  const id = notionUserId(value);
  if (!id) return null;

  const listed = context.users.get(id);
  if (listed) return listed.slug;

  const inline = parseNotionUser(value);
  const canonical = inline?.email
    ? context.identityLookup.get(normalizeIdentityAlias(inline.email))
    : null;
  return canonical?.slug ?? notionQualifiedUserId(id);
}

function notionPageEntityReferences(
  page: NotionSearchPage,
  context: NotionPageIdentityContext,
): {
  createdBy: string | null;
  lastEditedBy: string | null;
  people: string[];
  mentions: string[];
  relations: string[];
} {
  const people: string[] = [];
  const mentions: string[] = [];
  const relations: string[] = [];

  for (const property of Object.values(page.properties ?? {})) {
    const record = asObject(property);
    if (!record) continue;

    if (record.type === 'people' && Array.isArray(record.people)) {
      for (const user of record.people) {
        const reference = resolveNotionUserReference(user, context);
        if (reference) people.push(reference);
      }
    }

    if (record.type === 'title' || record.type === 'rich_text') {
      const richText =
        record.type === 'title' ? record.title : record.rich_text;
      for (const user of notionRichTextUsers(richText)) {
        const reference = resolveNotionUserReference(user, context);
        if (reference) mentions.push(reference);
      }
    }

    if (record.type === 'relation' && Array.isArray(record.relation)) {
      for (const relation of record.relation) {
        const id = notionUserId(relation);
        const slug = id ? notionPageSlug(id) : null;
        if (slug) relations.push(slug);
      }
    }
  }

  return {
    createdBy: resolveNotionUserReference(page.created_by, context),
    lastEditedBy: resolveNotionUserReference(page.last_edited_by, context),
    people: uniqueSorted(people),
    mentions: uniqueSorted(mentions),
    relations: uniqueSorted(relations),
  };
}

export function buildNotionPage(
  page: NotionSearchPage,
  markdown: NotionMarkdownResponse,
  options: {
    status?: 'active' | 'deleted' | 'unavailable';
    identityContext?: NotionPageIdentityContext;
  } = {},
): CollectorPage | null {
  const pageId = asString(page.id);
  if (!pageId) {
    return null;
  }
  const slug = notionPageSlug(pageId);
  if (!slug) {
    return null;
  }

  const status = options.status ?? (page.in_trash ? 'deleted' : 'active');
  const title = notionPageTitle(page);
  const createdAt = parseDate(page.created_time);
  const updatedAt = parseDate(page.last_edited_time) ?? createdAt;
  const sourceUrl = asString(page.url);
  const body = asString(markdown.markdown);
  const references = notionPageEntityReferences(
    page,
    options.identityContext ?? EMPTY_NOTION_PAGE_IDENTITY_CONTEXT,
  );

  return {
    slug,
    title,
    content: [
      ...renderBrainFrontmatter({
        type: BRAIN_PAGE_TYPES.notionPage,
        title,
        created: createdAt ?? updatedAt ?? null,
        fields: [
          `notion_page_id: ${JSON.stringify(pageId)}`,
          `status: ${status}`,
          'provenance: roomote-notion',
          updatedAt && `date: ${formatUtcDay(updatedAt)}`,
          createdAt && `created_at: ${createdAt.toISOString()}`,
          updatedAt && `last_edited_at: ${updatedAt.toISOString()}`,
          sourceUrl && `source_url: ${JSON.stringify(sourceUrl)}`,
          references.createdBy &&
            `created_by: ${JSON.stringify(references.createdBy)}`,
          references.lastEditedBy &&
            `last_edited_by: ${JSON.stringify(references.lastEditedBy)}`,
          references.people.length > 0 &&
            `people: ${JSON.stringify(references.people)}`,
          references.mentions.length > 0 &&
            `mentions: ${JSON.stringify(references.mentions)}`,
          references.relations.length > 0 &&
            `relations: ${JSON.stringify(references.relations)}`,
        ],
      }),
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
  return stableId ? `${brainNamespacePrefix('notion')}${stableId}` : null;
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

let notionPageIdentityContextCache: {
  loadedAt: number;
  context: NotionPageIdentityContext;
} | null = null;
const NOTION_IDENTITY_CONTEXT_CACHE_MS = 60 * 1000;

/**
 * DB-only identity context for page snapshots, memoized so backfill steps do
 * not reload the person-identity tables per step. Identity links are an
 * enrichment: a load failure degrades to unlinked references (or the last
 * loaded context) instead of blocking page collection.
 */
async function loadNotionPageIdentityContext(): Promise<NotionPageIdentityContext> {
  const now = Date.now();
  if (
    notionPageIdentityContextCache &&
    now - notionPageIdentityContextCache.loadedAt <
      NOTION_IDENTITY_CONTEXT_CACHE_MS
  ) {
    return notionPageIdentityContextCache.context;
  }

  try {
    const [directory, identities] = await Promise.all([
      loadNotionDirectory(),
      loadPersonIdentityRecords(),
    ]);
    const identityLookup = buildPersonIdentityLookup(identities);
    const context: NotionPageIdentityContext = {
      users: buildNotionUserReferences(
        directory.filter((user) => !user.deleted),
        identityLookup,
      ),
      identityLookup,
    };
    notionPageIdentityContextCache = { loadedAt: now, context };
    return context;
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} notion identity context load failed; collecting pages without fresh identity links: ${error instanceof Error ? error.message : String(error)}`,
    );
    return (
      notionPageIdentityContextCache?.context ??
      EMPTY_NOTION_PAGE_IDENTITY_CONTEXT
    );
  }
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
  const identityContext = await loadNotionPageIdentityContext();
  if (page.in_trash) {
    return buildNotionPage(page, {}, { identityContext });
  }

  try {
    const markdown = await notionCollectorRequest<NotionMarkdownResponse>({
      config,
      path: `pages/${encodeURIComponent(page.id)}/markdown`,
    });
    return buildNotionPage(page, markdown, { identityContext });
  } catch (error) {
    if (
      unavailableOnNotFound &&
      error instanceof NotionApiError &&
      error.status === 404
    ) {
      return buildNotionPage(
        page,
        {},
        { status: 'unavailable', identityContext },
      );
    }
    throw error;
  }
}

type NotionTraverseNode =
  | { kind: 'blocks'; id: string; depth: number; cursor?: string }
  | { kind: 'database'; id: string }
  | { kind: 'data_source'; id: string; cursor?: string };

type NotionTraverseState = {
  /** Durable iteration cursor over the inventory being walked. */
  afterItemId: string;
  /** Discovered containers awaiting expansion, bounded. */
  pending: NotionTraverseNode[];
};

type NotionScanCursor = {
  mode: 'idle' | 'incremental' | 'sweep' | 'reconcile' | 'traverse';
  lastSweepAt: string | null;
  upstreamCursor?: string;
  since?: string;
  scanStartedAt?: string;
  traverse?: NotionTraverseState;
};

function parseNotionScanCursor(raw: string | null): NotionScanCursor {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<NotionScanCursor>;
      if (
        parsed.mode === 'idle' ||
        parsed.mode === 'incremental' ||
        parsed.mode === 'sweep' ||
        parsed.mode === 'reconcile' ||
        parsed.mode === 'traverse'
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
          ...(parsed.traverse &&
          typeof parsed.traverse === 'object' &&
          typeof parsed.traverse.afterItemId === 'string' &&
          Array.isArray(parsed.traverse.pending)
            ? { traverse: parsed.traverse as NotionTraverseState }
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
    { status: 'unavailable' },
  );

  return {
    slug: item.slug,
    title: page?.title ?? 'Unavailable Notion page',
    content:
      page?.content ??
      `---\ntype: notion-page\nstatus: unavailable\nprovenance: roomote-notion\n---\n\n# Unavailable Notion page\n\nThis page is no longer available to the Notion integration.\n`,
  };
}

type NotionBlock = {
  object?: string;
  id?: string;
  type?: string;
  has_children?: boolean;
};

type NotionListResponse<T> = {
  results?: T[];
  has_more?: boolean;
  next_cursor?: string | null;
};

function isNotionBlock(value: unknown): value is NotionBlock {
  const block = asObject(value);
  return !!block && asString(block.id) !== undefined;
}

/**
 * Walk the inventory's block trees and data sources, emitting pages the
 * search-based sweep never surfaced. The seed side iterates
 * brain_collector_items by durable id cursor (no queue growth); only
 * discovered containers carry over between passes, bounded by
 * NOTION_TRAVERSAL_MAX_PENDING. A pass ends when its request budget or page
 * limit is spent; completion flips the scan back to idle.
 */
export async function collectNotionTraversal(input: {
  config: McpConnectionNotionConfig;
  saved: NotionScanCursor;
  limit: number;
  watermark?: Date | null;
}): Promise<CollectorResult> {
  const scanStartedAt = parseDate(input.saved.scanStartedAt) ?? new Date();
  const state: NotionTraverseState = input.saved.traverse ?? {
    afterItemId: '',
    pending: [],
  };
  let afterItemId = state.afterItemId;
  const pending: NotionTraverseNode[] = [...state.pending];
  const pages: CollectorPage[] = [];
  const itemUpdates: CollectorItemUpdate[] = [];
  const seenThisPass = new Set<string>();
  let requests = 0;
  let complete = false;
  let droppedNodes = 0;

  const pushPending = (node: NotionTraverseNode) => {
    if (pending.length >= NOTION_TRAVERSAL_MAX_PENDING) {
      droppedNodes++;
      return;
    }
    pending.push(node);
  };

  /**
   * An ingest costs two requests (page object + markdown). Refusing to start
   * one that cannot finish keeps the pass inside its budget, and stopping at
   * the page limit prevents an overshoot the engine would answer by
   * withholding state persistence — which would retry this same traversal
   * state forever.
   */
  const canIngestAnotherPage = () =>
    requests + 2 <= NOTION_MAX_TRAVERSAL_REQUESTS_PER_PASS &&
    pages.length < input.limit;

  const isKnownPage = async (pageId: string): Promise<boolean> => {
    if (seenThisPass.has(pageId)) {
      return true;
    }
    const rows = await listBrainCollectorItemsBySlugPrefix(
      db,
      NOTION_PAGES_COLLECTOR_ID,
      pageId,
      1,
    );
    return rows.length > 0 && rows[0]!.itemId === pageId;
  };

  const ingestDiscoveredPage = async (pageId: string): Promise<void> => {
    if (await isKnownPage(pageId)) {
      return;
    }
    seenThisPass.add(pageId);
    let page: unknown;
    try {
      requests++;
      page = await notionCollectorRequest<unknown>({
        config: input.config,
        path: `pages/${encodeURIComponent(pageId)}`,
      });
    } catch (error) {
      // A child_page block whose page the integration cannot read (or that
      // moved to the trash between listing and fetch) is not a traversal
      // failure; the rest of the tree still counts.
      if (error instanceof NotionApiError && error.status === 404) {
        return;
      }
      throw error;
    }
    if (!isNotionSearchPage(page)) {
      return;
    }
    const mapped = await fetchNotionPage(input.config, page);
    requests++;
    if (mapped) {
      pages.push(mapped);
      itemUpdates.push(notionItemUpdate(page, mapped.slug, scanStartedAt));
      // The new page's own subtree may hide further pages.
      pushPending({ kind: 'blocks', id: pageId, depth: 0 });
    }
  };

  // Freshness skim: a traversal cycle spans hours of ticks, and routing
  // every tick here would pause incremental scanning for the whole walk —
  // turning minutes of edit-to-Brain latency into hours, daily. One
  // newest-first search page per tick keeps recent edits flowing; anything
  // deeper than a page waits for the post-traversal incremental pass, whose
  // watermark only advances here when the skim provably caught up.
  let watermarkUpdate: Date | undefined;
  if (input.watermark && requests < NOTION_MAX_TRAVERSAL_REQUESTS_PER_PASS) {
    const skimStartedAt = new Date();
    requests++;
    const skim = await searchNotionPages({
      config: input.config,
      cursor: null,
      pageSize: NOTION_SEARCH_PAGE_SIZE,
    });
    const edited = skim.pages.filter((page) => {
      const updatedAt = parseDate(page.last_edited_time);
      return (
        updatedAt && updatedAt > input.watermark! && updatedAt <= skimStartedAt
      );
    });
    const caughtUp = skim.pages.some((page) => {
      const updatedAt = parseDate(page.last_edited_time);
      return updatedAt ? updatedAt <= input.watermark! : false;
    });
    for (const page of edited) {
      if (
        requests + 1 > NOTION_MAX_TRAVERSAL_REQUESTS_PER_PASS ||
        pages.length >= input.limit
      ) {
        break;
      }
      const mapped = await fetchNotionPage(input.config, page);
      requests++;
      if (mapped) {
        pages.push(mapped);
        itemUpdates.push(notionItemUpdate(page, mapped.slug, skimStartedAt));
        seenThisPass.add(page.id);
      }
    }
    if (caughtUp && edited.length > 0) {
      watermarkUpdate = skimStartedAt;
    }
  }

  while (
    requests < NOTION_MAX_TRAVERSAL_REQUESTS_PER_PASS &&
    pages.length < input.limit
  ) {
    const node = pending.shift();

    if (!node) {
      const batch = await listBrainCollectorItemsAfter(
        db,
        NOTION_PAGES_COLLECTOR_ID,
        afterItemId,
        NOTION_TRAVERSAL_SEED_BATCH,
      );
      if (batch.length === 0) {
        complete = true;
        break;
      }
      for (const item of batch) {
        pushPending({ kind: 'blocks', id: item.itemId, depth: 0 });
      }
      afterItemId = batch[batch.length - 1]!.itemId;
      continue;
    }

    if (node.kind === 'blocks') {
      let listed: NotionListResponse<unknown>;
      try {
        requests++;
        listed = await notionCollectorRequest<NotionListResponse<unknown>>({
          config: input.config,
          path: `blocks/${encodeURIComponent(node.id)}/children`,
          query: {
            page_size: NOTION_TRAVERSAL_BLOCK_PAGE_SIZE,
            ...(node.cursor ? { start_cursor: node.cursor } : {}),
          },
        });
      } catch (error) {
        if (error instanceof NotionApiError && error.status === 404) {
          continue;
        }
        throw error;
      }
      // Containers found in this response are committed only if the whole
      // response is processed. On a mid-response stop the node re-queues
      // with the same cursor, so committing eagerly would duplicate these
      // pushes when the response is re-listed next pass. Ingest-driven
      // pushes (a discovered page's own subtree) stay immediate: a page
      // ingests exactly once, so they cannot repeat.
      const discoveredContainers: NotionTraverseNode[] = [];
      let stoppedMidResponse = false;
      for (const raw of listed.results ?? []) {
        if (!isNotionBlock(raw) || !raw.id) {
          continue;
        }
        if (raw.type === 'child_page') {
          if (!canIngestAnotherPage()) {
            stoppedMidResponse = true;
            break;
          }
          await ingestDiscoveredPage(raw.id);
        } else if (raw.type === 'child_database') {
          discoveredContainers.push({ kind: 'database', id: raw.id });
        } else if (
          raw.has_children &&
          node.depth < NOTION_TRAVERSAL_MAX_BLOCK_DEPTH
        ) {
          // Any block Notion reports as having children can hide a child
          // page (paragraph indents, to-dos, toggleable headings, …); an
          // allowlist here is exactly the discovery gap this phase closes.
          discoveredContainers.push({
            kind: 'blocks',
            id: raw.id,
            depth: node.depth + 1,
          });
        }
      }
      if (stoppedMidResponse) {
        pushPending(node);
        break;
      }
      for (const container of discoveredContainers) {
        pushPending(container);
      }
      if (listed.has_more && asString(listed.next_cursor)) {
        pushPending({ ...node, cursor: listed.next_cursor!.trim() });
      }
      continue;
    }

    if (node.kind === 'database') {
      let database: Record<string, unknown> | null | undefined;
      try {
        requests++;
        database = asObject(
          await notionCollectorRequest<unknown>({
            config: input.config,
            path: `databases/${encodeURIComponent(node.id)}`,
          }),
        );
      } catch (error) {
        if (error instanceof NotionApiError && error.status === 404) {
          continue;
        }
        throw error;
      }
      const dataSources = Array.isArray(database?.data_sources)
        ? database!.data_sources
        : [];
      for (const raw of dataSources) {
        const id = asString(asObject(raw)?.id);
        if (id) {
          pushPending({ kind: 'data_source', id });
        }
      }
      continue;
    }

    // node.kind === 'data_source' — Notion's recommended enumeration path.
    let queried: NotionListResponse<unknown>;
    try {
      requests++;
      queried = await notionCollectorRequest<NotionListResponse<unknown>>({
        config: input.config,
        path: `data_sources/${encodeURIComponent(node.id)}/query`,
        method: 'POST',
        body: {
          page_size: NOTION_TRAVERSAL_QUERY_PAGE_SIZE,
          ...(node.cursor ? { start_cursor: node.cursor } : {}),
        },
      });
    } catch (error) {
      if (error instanceof NotionApiError && error.status === 404) {
        continue;
      }
      throw error;
    }
    let stoppedMidRows = false;
    for (const raw of queried.results ?? []) {
      const id = asString(asObject(raw)?.id);
      if (!id) {
        continue;
      }
      if (!canIngestAnotherPage()) {
        stoppedMidRows = true;
        break;
      }
      await ingestDiscoveredPage(id);
    }
    if (stoppedMidRows) {
      // Re-query the same row page next pass; already-ingested rows skip via
      // the inventory check, so the retry converges.
      pushPending(node);
      break;
    }
    if (queried.has_more && asString(queried.next_cursor)) {
      pushPending({ ...node, cursor: queried.next_cursor!.trim() });
    }
  }

  if (droppedNodes > 0) {
    console.warn(
      `${LOG_PREFIX} notion traversal dropped ${droppedNodes} discovered container(s) past the pending cap; they are revisited on the next cycle`,
    );
  }

  return {
    pages,
    nextSince: null,
    itemUpdates,
    stateUpdates: [
      {
        collectorId: NOTION_INCREMENTAL_STATE_ID,
        ...(watermarkUpdate ? { watermark: watermarkUpdate } : {}),
        cursor: serializeNotionScanCursor(
          complete
            ? { mode: 'idle', lastSweepAt: input.saved.lastSweepAt }
            : {
                mode: 'traverse',
                lastSweepAt: input.saved.lastSweepAt,
                scanStartedAt: scanStartedAt.toISOString(),
                traverse: {
                  afterItemId,
                  pending: pending.slice(0, NOTION_TRAVERSAL_MAX_PENDING),
                },
              },
        ),
      },
    ],
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
                // Reconcile settles the sweep's watermark; traversal then
                // hunts the pages Notion's search index never surfaced.
                mode: 'traverse',
                lastSweepAt: scanStartedAt.toISOString(),
                scanStartedAt: scanStartedAt.toISOString(),
                traverse: { afterItemId: '', pending: [] },
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
  if (saved.mode === 'traverse') {
    return collectNotionTraversal({
      config: input.config,
      saved,
      limit: input.limit,
      watermark: state?.watermark ?? null,
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

type NotionUserProjectionEntry = {
  user: NotionDirectoryUser;
  reference: NotionUserReference;
};

/**
 * Everything a Notion user card's content depends on. When this changes for
 * any user — a rename, a deletion, or a canonical link appearing after a
 * member signs up — the next tick re-emits the affected pages instead of
 * waiting out the daily refresh.
 */
function notionUsersProjectionHash(
  entries: NotionUserProjectionEntry[],
): string {
  const projection = entries.map(({ user, reference }) => ({
    id: user.id,
    name: user.name,
    deleted: user.deleted,
    title: reference.title,
    canonical: reference.canonical?.slug ?? null,
  }));

  return createHash('sha256').update(JSON.stringify(projection)).digest('hex');
}

type NotionUsersEmitCursor = {
  projectionHash: string | null;
  afterUserId?: string;
};

function parseNotionUsersEmitCursor(raw: string | null): NotionUsersEmitCursor {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<NotionUsersEmitCursor>;
      return {
        projectionHash:
          typeof parsed.projectionHash === 'string'
            ? parsed.projectionHash
            : null,
        ...(typeof parsed.afterUserId === 'string'
          ? { afterUserId: parsed.afterUserId }
          : {}),
      };
    } catch {
      // Restart with a full idempotent sweep if the cursor is unreadable.
    }
  }

  return { projectionHash: null };
}

export function selectNotionUserBatch(input: {
  entries: NotionUserProjectionEntry[];
  state: { watermark: Date | null; cursor: string | null } | null;
  now: Date;
  limit: number;
}): {
  entries: NotionUserProjectionEntry[];
  watermark: Date;
  cursor: string;
} {
  const saved = parseNotionUsersEmitCursor(input.state?.cursor ?? null);
  const projectionHash = notionUsersProjectionHash(input.entries);
  const projectionChanged = saved.projectionHash !== projectionHash;
  const continuing = saved.afterUserId !== undefined;
  const sweepDue =
    !input.state?.watermark ||
    input.now.getTime() - input.state.watermark.getTime() >=
      NOTION_USERS_REFRESH_MS;

  if (!continuing && !projectionChanged && !sweepDue) {
    return {
      entries: [],
      watermark: input.state!.watermark!,
      cursor: JSON.stringify({
        projectionHash,
      } satisfies NotionUsersEmitCursor),
    };
  }

  const { batch, lastId, hasMore } = selectSweepSlice({
    items: input.entries,
    idOf: (entry) => entry.user.id,
    afterId: continuing && !projectionChanged ? saved.afterUserId! : '',
    limit: input.limit,
  });

  return {
    entries: batch,
    watermark: hasMore ? (input.state?.watermark ?? new Date(0)) : input.now,
    cursor: JSON.stringify(
      (hasMore && lastId
        ? { projectionHash, afterUserId: lastId }
        : { projectionHash }) satisfies NotionUsersEmitCursor,
    ),
  };
}

export const notionUsersCollector: BrainCollector = {
  id: NOTION_USERS_COLLECTOR_ID,
  displayName: 'Notion workspace users',
  async isEnabled() {
    if (await isBrainSourceAvailable('notion')) {
      return true;
    }
    // Stored directory rows still need deletion tombstones after the
    // integration is removed.
    const rows = await db
      .select({ id: notionDirectoryUsers.id })
      .from(notionDirectoryUsers)
      .limit(1);
    return rows.length > 0;
  },
  async collect({ now, limit }) {
    const config = await findBrainSourceConnectionConfig('notion');
    const stateUpdates: CollectorStateUpdate[] = [];

    if (config) {
      const refreshState = await getBrainSyncState(
        db,
        NOTION_USERS_REFRESH_STATE_ID,
      );
      const refreshUpdate = await refreshNotionUserDirectory({
        config,
        state: refreshState
          ? {
              watermark: refreshState.watermark,
              backfillCursor: refreshState.backfillCursor,
            }
          : null,
        now,
      });
      if (refreshUpdate) {
        stateUpdates.push(refreshUpdate);
      }
    } else {
      // The integration was removed: retract every stored directory row so
      // the projected person cards tombstone below.
      await tombstoneNotionDirectoryUsers(null, now);
    }

    const directory = await loadNotionDirectory();
    if (directory.length === 0) {
      return { pages: [], nextSince: null, stateUpdates };
    }

    // Deleted rows never link, so an all-deleted directory (integration
    // removed or capability revoked) skips the person-identity load entirely.
    const identityLookup = directory.some((user) => !user.deleted)
      ? buildPersonIdentityLookup(await loadPersonIdentityRecords())
      : new Map<string, PersonIdentityReference>();
    const references = buildNotionUserReferences(directory, identityLookup);
    const state = await getBrainSyncState(db, NOTION_USERS_COLLECTOR_ID);
    const batch = selectNotionUserBatch({
      entries: directory.map((user) => ({
        user,
        reference: references.get(user.id)!,
      })),
      state: state
        ? { watermark: state.watermark, cursor: state.backfillCursor }
        : null,
      now,
      limit,
    });
    stateUpdates.push({
      collectorId: NOTION_USERS_COLLECTOR_ID,
      watermark: batch.watermark,
      cursor: batch.cursor,
    });

    return {
      pages: batch.entries.map(({ user, reference }) =>
        buildNotionUserPage(user, reference),
      ),
      nextSince: null,
      stateUpdates,
    };
  },
};
export const notionPagesCollector: BrainCollector = {
  id: NOTION_PAGES_COLLECTOR_ID,
  displayName: 'Notion pages',
  async isEnabled() {
    const [available, tracked] = await Promise.all([
      isBrainSourceAvailable('notion'),
      listBrainCollectorItems(db, NOTION_PAGES_COLLECTOR_ID, 1),
    ]);
    return available || tracked.length > 0;
  },
  async collect({ now, limit }) {
    const config = await findBrainSourceConnectionConfig('notion');
    return config
      ? collectNotionPages({ config, now, limit })
      : collectDisabledNotionPages(limit);
  },
  async backfill({ cursor, limit }) {
    const config = await findBrainSourceConnectionConfig('notion');
    return config
      ? backfillNotionPagesStep(config, cursor, limit)
      : { pages: [], nextCursor: cursor, done: false };
  },
};
