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

function parseCensusOffset(raw: string | null): number {
  if (!raw) {
    return 0;
  }

  try {
    const parsed = JSON.parse(raw) as { offset?: unknown };

    return typeof parsed.offset === 'number' && parsed.offset >= 0
      ? Math.floor(parsed.offset)
      : 0;
  } catch {
    return 0;
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
 * Slack day page that predates item tracking. Paged with `offset` under a
 * durable cursor, so a large corpus can span ticks; typically it completes in
 * the first one. Seeding never overwrites rows the live collector already
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

  let offset = parseCensusOffset(state?.backfillCursor ?? null);
  let previousWindowKey: string | null = null;

  for (let windows = 0; windows < CENSUS_MAX_WINDOWS_PER_RUN; windows++) {
    const payloads = await callBrainTool(
      connection,
      'list_pages',
      { limit: CENSUS_LISTING_WINDOW, offset },
      { timeoutMs: CENSUS_REQUEST_TIMEOUT_MS },
    );
    const listed = extractBrainCorpusPages(payloads);
    const windowKey = listed.map((page) => page.slug).join('\n');
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

    if (windows > 0 && windowKey === previousWindowKey) {
      // The server ignored `offset` and answered the first window again.
      // Complete rather than spin: retirement only ever touches slugs that
      // ARE in the inventory, so an incomplete census costs healing coverage
      // for the unlisted pages, never safety.
      console.warn(
        `${LOG_PREFIX} slack day-page census: listing ignored offset; completing with a partial inventory`,
      );
      break;
    }

    if (listed.length < CENSUS_LISTING_WINDOW) {
      break;
    }

    previousWindowKey = windowKey;
    offset += listed.length;
    await upsertBrainSyncState(db, SLACK_DAY_PAGE_CENSUS_STATE_ID, {
      backfillCursor: JSON.stringify({ offset }),
    });

    if (windows === CENSUS_MAX_WINDOWS_PER_RUN - 1) {
      // Out of window budget; the cursor above resumes next tick.
      return;
    }
  }

  await upsertBrainSyncState(db, SLACK_DAY_PAGE_CENSUS_STATE_ID, {
    backfillCursor: null,
    backfillCompletedAt: new Date(),
  });
  console.log(`${LOG_PREFIX} slack day-page census complete`);
}
