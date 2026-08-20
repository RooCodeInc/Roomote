import {
  callBrainTool,
  extractBrainCorpusPages,
  resolveBrainConnection,
} from '@roomote/sdk/server';
import {
  db,
  getBrainSyncState,
  listBrainCollectorItemsBySlugPrefix,
  seedBrainCollectorItems,
  upsertBrainSyncState,
} from '@roomote/db/server';
import { brainNamespacePrefix } from '@roomote/types';

import type {
  CollectorItemUpdate,
  CollectorPage,
  CollectorPageRetirement,
} from './contracts';

const LOG_PREFIX = '[brainCollectors]';

/**
 * Slack day pages: slug inventory and retirement
 * ----------------------------------------------
 *
 * A Slack day page's slug embeds the first/last message timestamps of the
 * batch that emitted it, and batch boundaries depend on when past reads ran.
 * That makes the pages immutable by construction — a later tick can never
 * replace an earlier partial day — but it also means a replay mints DIFFERENT
 * slugs for the same messages and leaves the old pages standing next to
 * duplicates of their content. Healing therefore needs retirement, not
 * replacement: know which slugs this collector emitted, and soft-delete the
 * ones a re-read fully supersedes.
 *
 * Two pieces make that possible:
 *
 * 1. An inventory (brain_collector_items, itemId = slug) of every emitted day
 *    page, written alongside the pages themselves. gbrain's `list_pages` has
 *    no slug-prefix filter, so this local inventory is the only way to ask
 *    "which pages exist for this channel-day".
 * 2. A one-time census that walks gbrain's full page listing and seeds the
 *    inventory with day pages emitted before tracking existed. Collection is
 *    held until the census completes so a replay can never re-emit a day
 *    while its legacy slugs are still invisible.
 *
 * Retirement itself is decided by RANGE COVERAGE, not by day re-emission
 * alone: an old page is superseded only when the union of ranges emitted for
 * its channel-day in one pass contains the old page's entire embedded range.
 * One pass's messages for a day are a contiguous time slice (one bounded
 * incremental window, or one Slack history cursor page), so containment
 * proves every message the old page could describe was just re-read and
 * re-emitted — or was deleted upstream. This is what keeps every hard case
 * safe by construction:
 *
 * - Steady-state incremental ticks fetch disjoint windows, so they never
 *   cover an earlier chunk's range and never retire anything.
 * - A partial-day fetch (window opens mid-day, busy day spanning history
 *   cursor pages) covers only its own slice; older chunks outside it stay.
 * - A day Slack no longer serves (retention) re-emits nothing, covers
 *   nothing, and retires nothing — pages holding history the API has lost
 *   are deliberately kept.
 */

/**
 * Inventory id for emitted Slack day pages. Deliberately NOT the versioned
 * collector id: a version bump exists to replay and retire the pages the
 * previous version emitted, so the inventory has to survive the bump.
 */
export const SLACK_DAY_PAGE_ITEMS_ID = 'slack-public-channels:day-pages';

/** Upper bound on tracked pages considered per channel-day. */
const SLACK_DAY_PAGE_TRACKED_LIMIT = 1_000;

/**
 * Microsecond-precision sort key for one half of a slug's timestamp range.
 * Slack timestamps are "seconds.micros"; slugs store them with the dot
 * replaced by a dash. Seconds since epoch times 1e6 stays far below
 * Number.MAX_SAFE_INTEGER.
 */
function slackTsKey(seconds: string, fraction: string): number {
  return (
    Number(seconds) * 1_000_000 + Number(fraction.padEnd(6, '0').slice(0, 6))
  );
}

type SlackDayPageSlugRange = {
  /** Everything through the trailing slash: `slack/{team}/{channel}/{day}/`. */
  dayPrefix: string;
  firstKey: number;
  lastKey: number;
};

/**
 * Parse a Slack day-page slug's channel-day prefix and embedded timestamp
 * range, or return null for anything that is not a day page (person pages,
 * other namespaces, malformed slugs). The shape is
 * `slack/{team}/{channel}/{YYYY-MM-DD}/{firstTs}-{lastTs}` with each ts's dot
 * written as a dash.
 */
export function parseSlackDayPageSlug(
  slug: string,
): SlackDayPageSlugRange | null {
  const match = slug.match(
    /^(slack\/[^/]+\/[^/]+\/\d{4}-\d{2}-\d{2}\/)(\d+)-(\d+)-(\d+)-(\d+)$/,
  );

  if (!match) {
    return null;
  }

  const firstKey = slackTsKey(match[2]!, match[3]!);
  const lastKey = slackTsKey(match[4]!, match[5]!);

  return Number.isFinite(firstKey) && Number.isFinite(lastKey)
    ? { dayPrefix: match[1]!, firstKey, lastKey }
    : null;
}

/**
 * Inventory updates and retirements for one batch of freshly grouped day
 * pages. `pages` must come from ONE contiguous fetch (an incremental window
 * or one backfill history page) — contiguity is what lets the per-day union
 * of emitted ranges stand in for "everything in this interval was re-read".
 */
export async function reconcileSlackDayPages(input: {
  pages: CollectorPage[];
  now: Date;
}): Promise<{
  itemUpdates: CollectorItemUpdate[];
  pageRetirements: CollectorPageRetirement[];
}> {
  const itemUpdates = input.pages.map((page) => ({
    collectorId: SLACK_DAY_PAGE_ITEMS_ID,
    itemId: page.slug,
    slug: page.slug,
    lastSeenAt: input.now,
  }));

  const emitted = new Set(input.pages.map((page) => page.slug));
  const coverage = new Map<string, { firstKey: number; lastKey: number }>();

  for (const page of input.pages) {
    const parsed = parseSlackDayPageSlug(page.slug);

    if (!parsed) {
      continue;
    }

    const existing = coverage.get(parsed.dayPrefix);
    coverage.set(parsed.dayPrefix, {
      firstKey: Math.min(
        existing?.firstKey ?? parsed.firstKey,
        parsed.firstKey,
      ),
      lastKey: Math.max(existing?.lastKey ?? parsed.lastKey, parsed.lastKey),
    });
  }

  const pageRetirements: CollectorPageRetirement[] = [];

  for (const [dayPrefix, range] of coverage) {
    const tracked = await listBrainCollectorItemsBySlugPrefix(
      db,
      SLACK_DAY_PAGE_ITEMS_ID,
      dayPrefix,
      SLACK_DAY_PAGE_TRACKED_LIMIT,
    );

    for (const item of tracked) {
      if (emitted.has(item.itemId)) {
        continue;
      }

      const parsed = parseSlackDayPageSlug(item.itemId);

      // Retire only when the old page's whole range was just re-read. A page
      // reaching outside the emitted interval may describe messages this
      // fetch never saw, so it stays even though its day was re-emitted.
      if (
        !parsed ||
        parsed.firstKey < range.firstKey ||
        parsed.lastKey > range.lastKey
      ) {
        continue;
      }

      pageRetirements.push({
        collectorId: SLACK_DAY_PAGE_ITEMS_ID,
        itemId: item.itemId,
        slug: item.slug,
      });
    }
  }

  return { itemUpdates, pageRetirements };
}

const SLACK_DAY_PAGE_CENSUS_STATE_ID = 'slack-public-channels:day-pages:census';
/** One `list_pages` window; gbrain caps `limit` at 100 regardless of ask. */
const CENSUS_LISTING_WINDOW = 100;
/** Windows per run, so one census pass cannot monopolize a collector tick. */
const CENSUS_MAX_WINDOWS_PER_RUN = 200;
const CENSUS_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Durable census position. A raw listing offset would not survive concurrent
 * writes: `list_pages` defaults to recency order, so pages written between
 * windows shift every position and a resumed offset silently skips (or
 * re-reads) rows — skips being the fatal case, because a skipped legacy slug
 * is missing from the inventory forever and the census then reports itself
 * complete. Instead the census walks `sort: 'updated_asc'` with an
 * `updated_after` keyset, gbrain's own documented idiom for exhaustive
 * pagination. Under ascending updated_at a row can only ever move LATER (its
 * updated_at is monotonically non-decreasing), so anything that shifts out
 * from under the cursor reappears ahead of it and deletions shift nothing:
 * churn produces duplicate reads, never skips, and duplicate seeding is a
 * no-op.
 *
 * `updated_after` is a strict > filter, so a cluster of pages sharing one
 * updated_at (bulk imports stamp identical now() across a transaction) that
 * is wider than one window cannot be crossed by timestamp alone. Inside such
 * a cluster the walk holds `after` fixed and pages by `offset`, verifying an
 * overlap row on each continuation so a cluster member re-stamped mid-walk
 * (which shifts the remaining rows) restarts the cluster instead of skipping
 * one.
 */
type SlackCensusCursor = {
  /** Every page with updated_at at or before this boundary is inventoried. */
  after: string | null;
  /** Position inside one same-updated_at cluster wider than a window. */
  offset: number;
  /** Last slug seen in cluster mode; the continuation's overlap check. */
  lastSlug: string | null;
};

const CENSUS_START: SlackCensusCursor = {
  after: null,
  offset: 0,
  lastSlug: null,
};

function parseCensusCursor(raw: string | null): SlackCensusCursor {
  if (!raw) {
    return CENSUS_START;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Anything but this shape (including the pre-keyset `{offset}` cursor,
    // whose position is not trustworthy) restarts the walk; re-seeding is
    // idempotent.
    if (typeof parsed.after !== 'string' && parsed.after !== null) {
      return CENSUS_START;
    }

    return {
      after: (parsed.after as string | null) ?? null,
      offset:
        typeof parsed.offset === 'number' && parsed.offset > 0
          ? Math.floor(parsed.offset)
          : 0,
      lastSlug: typeof parsed.lastSlug === 'string' ? parsed.lastSlug : null,
    };
  } catch {
    return CENSUS_START;
  }
}

/**
 * Whether the one-time inventory census has finished. Slack collection (both
 * incremental and backfill) holds until it has: re-emitting a day before its
 * legacy slugs are in the inventory would let those pages dodge retirement
 * permanently, because nothing revisits a day after its watermark passes.
 */
export async function isSlackDayPageCensusComplete(): Promise<boolean> {
  const state = await getBrainSyncState(db, SLACK_DAY_PAGE_CENSUS_STATE_ID);

  return Boolean(state?.backfillCompletedAt);
}

/**
 * Walk gbrain's full page listing once and seed the inventory with every
 * Slack day page that predates item tracking. The walk is a keyset scan in
 * updated_at order (see SlackCensusCursor for why a raw offset would skip
 * rows under concurrent writes), durable across ticks; typically it completes
 * in the first one. Seeding never overwrites rows the live collector already
 * wrote. Corpus recreation wipes brain_sync_state, which re-arms this census
 * against the fresh (empty) corpus automatically.
 */
export async function runSlackDayPageCensus(): Promise<void> {
  const state = await getBrainSyncState(db, SLACK_DAY_PAGE_CENSUS_STATE_ID);

  if (state?.backfillCompletedAt) {
    return;
  }

  // The read-scoped connection, same as every other list_pages caller. The
  // collectors' write scope is not known to include listing.
  const connection = await resolveBrainConnection('agent');

  if (!connection) {
    console.warn(
      `${LOG_PREFIX} slack day-page census has no read connection; slack collection stays held until one resolves`,
    );
    return;
  }

  let cursor = parseCensusCursor(state?.backfillCursor ?? null);
  let complete = false;
  let partialReason: string | null = null;

  for (let windows = 0; windows < CENSUS_MAX_WINDOWS_PER_RUN; windows++) {
    // Continuing inside a tie cluster re-reads the last seen row, so a
    // cluster that shifted between windows (a member re-stamped and moved
    // later) is detected instead of silently skipping its successor.
    const overlapping = cursor.offset > 0 && cursor.lastSlug !== null;
    const requestOffset = overlapping ? cursor.offset - 1 : cursor.offset;
    const payloads = await callBrainTool(
      connection,
      'list_pages',
      {
        limit: CENSUS_LISTING_WINDOW,
        sort: 'updated_asc',
        ...(cursor.after ? { updated_after: cursor.after } : {}),
        ...(requestOffset > 0 ? { offset: requestOffset } : {}),
      },
      { timeoutMs: CENSUS_REQUEST_TIMEOUT_MS },
    );
    let listed = extractBrainCorpusPages(payloads);
    const windowFull = listed.length >= CENSUS_LISTING_WINDOW;

    if (overlapping) {
      if (listed[0]?.slug === cursor.lastSlug) {
        listed = listed.slice(1);
      } else {
        cursor = { after: cursor.after, offset: 0, lastSlug: null };
        await upsertBrainSyncState(db, SLACK_DAY_PAGE_CENSUS_STATE_ID, {
          backfillCursor: JSON.stringify(cursor),
        });
        continue;
      }
    }

    const slackPrefix = brainNamespacePrefix('slack');
    const dayPages = listed.filter(
      (page) =>
        page.slug.startsWith(slackPrefix) &&
        parseSlackDayPageSlug(page.slug) !== null,
    );

    await seedBrainCollectorItems(
      db,
      SLACK_DAY_PAGE_ITEMS_ID,
      dayPages.map((page) => ({
        itemId: page.slug,
        slug: page.slug,
        // Epoch marks "known from the census, never seen by live collection".
        lastSeenAt: new Date(0),
      })),
    );

    if (!windowFull) {
      complete = true;
      break;
    }

    // Timestamps drive the keyset. A server that answers without them (or
    // ignores the ascending sort, leaving nothing older than the window's
    // last row) cannot be walked exhaustively; completing with what was
    // seeded costs healing coverage for the unlisted pages, never safety —
    // retirement only ever touches slugs that ARE in the inventory.
    const lastAt = listed.at(-1)?.updatedAt ?? null;
    const earlier = lastAt
      ? listed.filter((page) => page.updatedAt && page.updatedAt < lastAt)
      : [];
    const someEarlier = Boolean(
      lastAt &&
      listed.some(
        (page) =>
          !page.updatedAt || page.updatedAt.getTime() !== lastAt.getTime(),
      ),
    );

    let next: SlackCensusCursor;

    if (!lastAt || (someEarlier && earlier.length === 0)) {
      partialReason = 'listing is not walkable in updated_at order';
      complete = true;
      break;
    } else if (someEarlier) {
      // Advance the boundary to the last timestamp known to be fully seen
      // and drop the window's trailing cluster: in ascending order every row
      // older than the boundary sat inside this window. The trailing cluster
      // is re-read (and idempotently re-seeded) from the new boundary.
      const boundary = earlier.reduce((max, page) =>
        page.updatedAt! > max.updatedAt! ? page : max,
      );
      next = {
        after: boundary.updatedAt!.toISOString(),
        offset: 0,
        lastSlug: null,
      };
    } else {
      // The whole window shares one updated_at: a tie cluster wider than a
      // window. Hold the boundary and page inside the cluster by offset.
      next = {
        after: cursor.after,
        offset: cursor.offset + listed.length,
        lastSlug: listed.at(-1)!.slug,
      };
    }

    if (next.after === cursor.after && next.offset === cursor.offset) {
      // No progress means the server ignored the keyset filter; walking
      // further would loop on the same window forever.
      partialReason = 'listing ignored the pagination cursor';
      complete = true;
      break;
    }

    cursor = next;
    await upsertBrainSyncState(db, SLACK_DAY_PAGE_CENSUS_STATE_ID, {
      backfillCursor: JSON.stringify(cursor),
    });
  }

  if (!complete) {
    // Out of window budget; the persisted cursor resumes next tick.
    return;
  }

  if (partialReason) {
    console.warn(
      `${LOG_PREFIX} slack day-page census: ${partialReason}; completing with a partial inventory`,
    );
  }

  await upsertBrainSyncState(db, SLACK_DAY_PAGE_CENSUS_STATE_ID, {
    backfillCursor: null,
    backfillCompletedAt: new Date(),
  });
  console.log(`${LOG_PREFIX} slack day-page census complete`);
}
