import {
  db,
  deleteBrainCollectorItems,
  getBrainSyncState,
  upsertBrainCollectorItems,
  upsertBrainSyncState,
} from '@roomote/db/server';

import {
  isBrainNotReady,
  isBrainRateLimited,
  postToBrain,
} from './brain-outbox-drain';
import type {
  BrainCollector,
  BrainConnection,
  BrainRetireSink,
  BrainSink,
  BrainTimelineSink,
  CollectorItemUpdate,
  CollectorPageRetirement,
} from './brain-collectors/contracts';
import {
  appendBrainTimelineEvidence,
  retireBrainPage,
  writeCollectorPages,
} from './brain-collectors/write-pages';
import { githubIssuesCollector } from './brain-collectors/github-issues';
import { granolaMeetingsCollector } from './brain-collectors/granola-meetings';
import {
  notionPagesCollector,
  notionUsersCollector,
} from './brain-collectors/notion-pages';
import { personIdentitiesCollector } from './brain-collectors/person-identities';
import { ripplingWorkersCollector } from './brain-collectors/rippling-workers';
import { slackPersonDirectoryCollector } from './brain-collectors/slack-directory';
import { slackPublicChannelsCollector } from './brain-collectors/slack-public-channels';

const LOG_PREFIX = '[brainCollectors]';

type BrainCollectorRunResult = {
  backfillProgressed: boolean;
  interrupted: boolean;
};

async function persistCollectorItemUpdates(
  updates: CollectorItemUpdate[],
): Promise<void> {
  const byCollector = new Map<string, CollectorItemUpdate[]>();
  for (const update of updates) {
    const existing = byCollector.get(update.collectorId) ?? [];
    existing.push(update);
    byCollector.set(update.collectorId, existing);
  }

  for (const [collectorId, items] of byCollector) {
    await upsertBrainCollectorItems(db, collectorId, items);
  }
}

/**
 * Soft-delete superseded pages, dropping each inventory row only once its
 * page retirement succeeded. Row by row on purpose: a failure mid-list keeps
 * every completed retirement durable, and the retire sink tolerates a page
 * that is already gone, so the retry converges.
 */
async function retireCollectorPages(
  retirements: CollectorPageRetirement[],
  connection: BrainConnection,
  retireSink: BrainRetireSink,
): Promise<void> {
  for (const retirement of retirements) {
    await retireSink(retirement.slug, connection);
    await deleteBrainCollectorItems(db, retirement.collectorId, [
      retirement.itemId,
    ]);
  }
}

/**
 * Per-collector, per-pass ceiling on pages written to the brain by the
 * incremental phase. Collectors are handed this as their `limit` and are
 * expected to return a `nextSince` covering only the pages they returned.
 * A collector that overshoots anyway has its watermark held back entirely
 * this pass, because the engine cannot know which history the pages it had
 * to drop covered, and a watermark past unwritten pages loses them for good.
 */
const MAX_PAGES_PER_COLLECTOR_PER_PASS = 100;

/**
 * Per-collector, per-pass page budget for the deep-backfill phase. Each
 * backfill step's pages are always fully posted before the cursor persists
 * (never a cursor past unposted pages), so a single step may overshoot the
 * budget by at most one upstream page size (~30-200 messages' worth of day
 * pages).
 */
const MAX_BACKFILL_PAGES_PER_COLLECTOR_PER_PASS = 100;

/**
 * Companion ceiling on backfill steps. The page budget alone does not bound a
 * tick's work: a step that yields zero pages still costs an upstream API call,
 * and walking a long tail of quiet Slack channels is exactly that shape, so
 * without this a single tick could make hundreds of calls while spending no
 * budget at all. Cursors persist per step, so a tick that stops here resumes
 * where it left off.
 */
const MAX_BACKFILL_STEPS_PER_COLLECTOR_PER_PASS = 25;

/**
 * Run every registered collector once, writing collected pages to the brain
 * through the outbox-drain `put_page` path so collected pages are immediately
 * retrievable instead of waiting behind gbrain's maintenance queue.
 *
 * Per collector and per pass: the incremental phase runs first (keeps the
 * brain fresh), then, while the initial deep backfill has not completed, a
 * bounded budget of older history is drained from the durable backfill
 * cursor. All position state lives in brain_sync_state, so restarts
 * and deploys never lose place.
 *
 * Error contract:
 * - A BrainRateLimitedError from the sink is backpressure: end the whole pass
 *   for this tick and let the next tick resume gently (cursors stay
 *   persisted). Only that typed error counts, never error prose that happens
 *   to mention a status code.
 * - Any other per-collector failure is logged and skipped; one broken source
 *   never blocks the others.
 */
export async function runBrainCollectors(
  connection: BrainConnection,
  options: {
    sink?: BrainSink;
    timelineSink?: BrainTimelineSink;
    retireSink?: BrainRetireSink;
    collectors?: BrainCollector[];
    /** Skip upstream incremental polls during fast historical continuation. */
    includeIncremental?: boolean;
  } = {},
): Promise<BrainCollectorRunResult> {
  const sink = options.sink ?? postToBrain;
  const timelineSink = options.timelineSink ?? appendBrainTimelineEvidence;
  const retireSink = options.retireSink ?? retireBrainPage;
  const collectors = options.collectors ?? BRAIN_COLLECTORS;
  const includeIncremental = options.includeIncremental ?? true;
  let backfillProgressed = false;

  for (const collector of collectors) {
    try {
      if (!(await collector.isEnabled())) {
        continue;
      }

      const state = await getBrainSyncState(db, collector.id);

      if (includeIncremental) {
        // Incremental phase runs once per scheduled tick: new activity stays
        // fresh without repeating upstream API polls in the one-second
        // historical continuation loop.
        const {
          pages,
          nextSince,
          stateUpdates = [],
          itemUpdates = [],
          itemDeletes = [],
          pageRetirements = [],
        } = await collector.collect({
          since: state?.watermark ?? null,
          now: new Date(),
          limit: MAX_PAGES_PER_COLLECTOR_PER_PASS,
        });
        const overshot = pages.length > MAX_PAGES_PER_COLLECTOR_PER_PASS;
        const capped = pages.slice(0, MAX_PAGES_PER_COLLECTOR_PER_PASS);

        await writeCollectorPages({
          pages: capped,
          connection,
          sink,
          timelineSink,
        });

        if (overshot) {
          console.warn(
            `${LOG_PREFIX} ${collector.id} returned ${pages.length} pages over a limit of ${MAX_PAGES_PER_COLLECTOR_PER_PASS}; holding its watermark so the remainder is re-collected`,
          );
        }

        if (!overshot) {
          // Retirements were computed against the full emission; on overshoot
          // part of that emission never landed, so retiring would delete
          // pages whose replacements do not exist yet. Superseded pages come
          // out only after every superseding page is in — and before any
          // watermark advances, so a failed retirement is recomputed from the
          // same window next tick instead of being lost behind a checkpoint.
          await retireCollectorPages(pageRetirements, connection, retireSink);

          // Advance only after every page landed; a mid-batch failure leaves
          // the watermark behind so the next tick retries the same
          // idempotent slugs.
          if (nextSince) {
            await upsertBrainSyncState(db, collector.id, {
              watermark: nextSince,
            });
          }

          await persistCollectorItemUpdates(itemUpdates);
          for (const deletion of itemDeletes) {
            await deleteBrainCollectorItems(
              db,
              deletion.collectorId,
              deletion.itemIds,
            );
          }
          for (const update of stateUpdates) {
            await upsertBrainSyncState(db, update.collectorId, {
              ...(update.watermark !== undefined
                ? { watermark: update.watermark }
                : {}),
              ...(update.cursor !== undefined
                ? { backfillCursor: update.cursor }
                : {}),
              ...(update.backfillCompletedAt !== undefined
                ? { backfillCompletedAt: update.backfillCompletedAt }
                : {}),
            });
          }
        }

        if (capped.length > 0) {
          console.log(
            `${LOG_PREFIX} ${collector.id} ingested ${capped.length} pages`,
          );
        }
      }

      const backfill = collector.backfill?.bind(collector);

      if (backfill && !state?.backfillCompletedAt) {
        backfillProgressed =
          (await drainCollectorBackfill({
            collectorId: collector.id,
            backfill,
            startCursor: state?.backfillCursor ?? null,
            connection,
            sink,
            timelineSink,
            retireSink,
          })) || backfillProgressed;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Neither is this collector's problem, and neither improves by moving
      // on to the next one: end the pass with every cursor still where it was.
      if (isBrainRateLimited(error) || isBrainNotReady(error)) {
        console.log(
          `${LOG_PREFIX} brain unavailable during ${collector.id} (${
            isBrainRateLimited(error) ? 'rate limited' : 'cannot embed'
          }); ending collector pass until next tick`,
        );
        return { backfillProgressed, interrupted: true };
      }

      console.warn(
        `${LOG_PREFIX} collector ${collector.id} (${collector.displayName}) failed: ${message}`,
      );
    }
  }

  return { backfillProgressed, interrupted: false };
}

/**
 * Drain bounded backfill steps until the pass's budget is spent, the
 * collector reports done, or a step makes no progress. Each step's pages are
 * fully posted before its cursor persists, so the durable cursor never moves
 * past unposted history; a sink failure mid-step leaves the previous cursor
 * in place and the same idempotent slugs are retried next tick.
 */
async function drainCollectorBackfill(input: {
  collectorId: string;
  backfill: NonNullable<BrainCollector['backfill']>;
  startCursor: string | null;
  connection: BrainConnection;
  sink: BrainSink;
  timelineSink: BrainTimelineSink;
  retireSink: BrainRetireSink;
}): Promise<boolean> {
  const {
    collectorId,
    backfill,
    startCursor,
    connection,
    sink,
    timelineSink,
    retireSink,
  } = input;
  let cursor = startCursor;
  let budget = MAX_BACKFILL_PAGES_PER_COLLECTOR_PER_PASS;
  let steps = 0;
  let ingested = 0;

  while (budget > 0 && steps < MAX_BACKFILL_STEPS_PER_COLLECTOR_PER_PASS) {
    steps++;
    const step = await backfill({ cursor, limit: budget });

    await writeCollectorPages({
      pages: step.pages,
      connection,
      sink,
      timelineSink,
    });

    await persistCollectorItemUpdates(step.itemUpdates ?? []);
    await retireCollectorPages(
      step.pageRetirements ?? [],
      connection,
      retireSink,
    );

    budget -= step.pages.length;
    ingested += step.pages.length;

    if (step.done) {
      await upsertBrainSyncState(db, collectorId, {
        backfillCursor: null,
        backfillCompletedAt: new Date(),
      });
      console.log(
        `${LOG_PREFIX} ${collectorId} deep backfill complete (${ingested} pages this pass)`,
      );
      return true;
    }

    const progressed = step.nextCursor !== cursor || step.pages.length > 0;

    await upsertBrainSyncState(db, collectorId, {
      backfillCursor: step.nextCursor,
    });
    cursor = step.nextCursor;

    if (!progressed) {
      return steps > 1 || ingested > 0;
    }
  }

  if (ingested > 0) {
    console.log(
      `${LOG_PREFIX} ${collectorId} backfilled ${ingested} pages; resuming next pass`,
    );
  }

  return cursor !== startCursor || ingested > 0;
}

const BRAIN_COLLECTORS: BrainCollector[] = [
  slackPersonDirectoryCollector,
  personIdentitiesCollector,
  ripplingWorkersCollector,
  slackPublicChannelsCollector,
  notionUsersCollector,
  notionPagesCollector,
  granolaMeetingsCollector,
  githubIssuesCollector,
];
