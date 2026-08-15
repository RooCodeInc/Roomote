import {
  and,
  db,
  eq,
  getBrainSyncState,
  isNull,
  mcpConnections,
  slackInstallations,
  upsertBrainSyncState,
} from '@roomote/db/server';
import { decrypt } from '@roomote/db/encryption';
import {
  backfillBrainGithubIssuesStep,
  collectBrainGithubIssues,
  hasBrainGithubSources,
} from '@roomote/sdk/server';
import { createSlackWebClient } from '@roomote/slack';
import {
  isMcpConnectionGranolaConfig,
  type McpConnectionGranolaConfig,
} from '@roomote/types';

import {
  isBrainNotReady,
  isBrainRateLimited,
  postToBrain,
  redactBrainText,
} from './brain-outbox-drain';

const LOG_PREFIX = '[brainCollectors]';

/**
 * Per-collector, per-tick ceiling on pages written to the brain by the
 * incremental phase. Collectors are handed this as their `limit` and are
 * expected to return a `nextSince` covering only the pages they returned.
 * A collector that overshoots anyway has its watermark held back entirely
 * this tick, because the engine cannot know which history the pages it had
 * to drop covered, and a watermark past unwritten pages loses them for good.
 */
const MAX_PAGES_PER_COLLECTOR_PER_TICK = 100;

/**
 * Per-collector, per-tick page budget for the deep-backfill phase. Each
 * backfill step's pages are always fully posted before the cursor persists
 * (never a cursor past unposted pages), so a single step may overshoot the
 * budget by at most one upstream page size (~30-200 messages' worth of day
 * pages).
 */
const MAX_BACKFILL_PAGES_PER_COLLECTOR_PER_TICK = 100;

/**
 * Companion ceiling on backfill steps. The page budget alone does not bound a
 * tick's work: a step that yields zero pages still costs an upstream API call,
 * and walking a long tail of quiet Slack channels is exactly that shape, so
 * without this a single tick could make hundreds of calls while spending no
 * budget at all. Cursors persist per step, so a tick that stops here resumes
 * where it left off.
 */
const MAX_BACKFILL_STEPS_PER_COLLECTOR_PER_TICK = 25;

export type CollectorPage = {
  slug: string;
  title: string;
  content: string;
};

export interface BrainCollector {
  id: string;
  displayName: string;
  isEnabled(): Promise<boolean>;
  collect(input: {
    since: Date | null;
    now: Date;
    limit: number;
  }): Promise<{ pages: CollectorPage[]; nextSince: Date | null }>;
  /**
   * Optional initial deep backfill over a longer history window, drained in
   * bounded steps across ticks. `cursor` is the collector's own opaque
   * resume token (persisted durably between passes); `done: true` marks the
   * backfill finished forever. A step that returns zero pages with an
   * unchanged cursor signals "no progress" (e.g. upstream auth trouble) and
   * ends this tick's backfill without marking it done.
   */
  backfill?(input: { cursor: string | null; limit: number }): Promise<{
    pages: CollectorPage[];
    nextCursor: string | null;
    done: boolean;
  }>;
}

type BrainConnection = { baseUrl: string; token: string };

export type BrainSink = (
  page: CollectorPage,
  connection: BrainConnection,
) => Promise<void>;

/**
 * Run every registered collector once, writing collected pages to the brain
 * through the outbox-drain `put_page` path (never gbrain's /ingest webhook:
 * its job worker is Postgres-only, so on the PGLite topology those events
 * would never become pages).
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
  options: { sink?: BrainSink; collectors?: BrainCollector[] } = {},
): Promise<void> {
  const sink = options.sink ?? postToBrain;
  const collectors = options.collectors ?? BRAIN_COLLECTORS;

  for (const collector of collectors) {
    try {
      if (!(await collector.isEnabled())) {
        continue;
      }

      const state = await getBrainSyncState(db, collector.id);

      // Incremental phase first: new activity reaches the brain within a
      // tick even while a long backfill is still draining.
      const { pages, nextSince } = await collector.collect({
        since: state?.watermark ?? null,
        now: new Date(),
        limit: MAX_PAGES_PER_COLLECTOR_PER_TICK,
      });
      const overshot = pages.length > MAX_PAGES_PER_COLLECTOR_PER_TICK;
      const capped = pages.slice(0, MAX_PAGES_PER_COLLECTOR_PER_TICK);

      for (const page of capped) {
        await sink(
          { ...page, content: redactBrainText(page.content) },
          connection,
        );
      }

      if (overshot) {
        console.warn(
          `${LOG_PREFIX} ${collector.id} returned ${pages.length} pages over a limit of ${MAX_PAGES_PER_COLLECTOR_PER_TICK}; holding its watermark so the remainder is re-collected`,
        );
      }

      // Advance only after every page landed; a mid-batch failure leaves the
      // watermark behind so the next tick retries the same idempotent slugs.
      if (nextSince && !overshot) {
        await upsertBrainSyncState(db, collector.id, {
          watermark: nextSince,
        });
      }

      if (capped.length > 0) {
        console.log(
          `${LOG_PREFIX} ${collector.id} ingested ${capped.length} pages`,
        );
      }

      const backfill = collector.backfill?.bind(collector);

      if (backfill && !state?.backfillCompletedAt) {
        await drainCollectorBackfill({
          collectorId: collector.id,
          backfill,
          startCursor: state?.backfillCursor ?? null,
          connection,
          sink,
        });
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
        return;
      }

      console.warn(
        `${LOG_PREFIX} collector ${collector.id} (${collector.displayName}) failed: ${message}`,
      );
    }
  }
}

/**
 * Drain bounded backfill steps until the tick's budget is spent, the
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
}): Promise<void> {
  const { collectorId, backfill, startCursor, connection, sink } = input;
  let cursor = startCursor;
  let budget = MAX_BACKFILL_PAGES_PER_COLLECTOR_PER_TICK;
  let steps = 0;
  let ingested = 0;

  while (budget > 0 && steps < MAX_BACKFILL_STEPS_PER_COLLECTOR_PER_TICK) {
    steps++;
    const step = await backfill({ cursor, limit: budget });

    for (const page of step.pages) {
      await sink(
        { ...page, content: redactBrainText(page.content) },
        connection,
      );
    }

    budget -= step.pages.length;
    ingested += step.pages.length;

    if (step.done) {
      await upsertBrainSyncState(db, collectorId, {
        backfillCursor: null,
        backfillCompletedAt: new Date(),
      });
      console.log(
        `${LOG_PREFIX} ${collectorId} deep backfill complete (${ingested} pages this tick)`,
      );
      return;
    }

    const progressed = step.nextCursor !== cursor || step.pages.length > 0;

    await upsertBrainSyncState(db, collectorId, {
      backfillCursor: step.nextCursor,
    });
    cursor = step.nextCursor;

    if (!progressed) {
      return;
    }
  }

  if (ingested > 0) {
    console.log(
      `${LOG_PREFIX} ${collectorId} backfilled ${ingested} pages; resuming next tick`,
    );
  }
}

/**
 * Slack: public channels the bot is a member of
 * ---------------------------------------------
 *
 * Deployment visibility by construction: adding the Roomote bot to a PUBLIC
 * channel is the designation act. Private channels and DMs are excluded
 * (`is_private` must be false), and only `is_member` channels are read.
 *
 * v1 reads top-level channel history only; per-thread `conversations.replies`
 * fan-out is deliberately skipped (one extra API call per threaded parent).
 * Thread parents and broadcast replies still appear via history.
 */

export type SlackChannelMessage = {
  channelId: string;
  channelName: string;
  /** Slack message ts, e.g. "1723500000.123456". */
  ts: string;
  userId: string | null;
  text: string;
};

const SLACK_HISTORY_LIMIT_PER_CHANNEL = 200;
/**
 * How far forward one incremental pass advances. Slack returns history
 * newest-first, so reading an unbounded window and stopping at a page limit
 * collects the newest slice and leaves a hole behind it. Bounding the window
 * by time instead means a pass either finishes what it asked for or asks for
 * less, and the watermark advances by at most this much per tick. Being behind
 * costs extra ticks, never lost messages.
 */
const SLACK_INCREMENTAL_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Pages read per channel within that window. A day of one channel exceeding
 * this is pathological rather than busy, and reaching it is reported rather
 * than absorbed, because past this point the choice is between dropping
 * messages and never advancing.
 */
const SLACK_INCREMENTAL_MAX_PAGES = 50;

/**
 * Floor for that narrowing. A channel producing more than the page ceiling
 * inside this is past what any window size rescues, so it is where the pass
 * stops halving and reports instead.
 */
const SLACK_MIN_WINDOW_MS = 15 * 60 * 1000;
/** How far back the very first incremental pass reads, before a watermark exists. */
const SLACK_FIRST_PASS_WINDOW_MS = 24 * 60 * 60 * 1000;
const SLACK_CHANNEL_LIST_PAGE_LIMIT = 999;
const SLACK_CHANNEL_LIST_MAX_PAGES = 10;

/** Membership-churn and housekeeping subtypes that carry no memory value. */
const SLACK_SKIPPED_SUBTYPES = new Set([
  'channel_join',
  'channel_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'channel_archive',
  'channel_unarchive',
  'bot_add',
  'bot_remove',
]);

function slackTsToDate(ts: string): Date | null {
  const seconds = Number.parseFloat(ts);

  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }

  // Truncate toward zero so the watermark never skips past a message whose
  // microsecond tail was lost; the worst case is one re-upserted page.
  return new Date(Math.floor(seconds * 1000));
}

function formatUtcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatUtcTime(date: Date): string {
  return date.toISOString().slice(11, 16);
}

/**
 * Group collected Slack messages into one page per channel per UTC day:
 * slug `slack/{channelId}/{YYYY-MM-DD}`. Re-upserting a day page as the day
 * grows is fine; slugs are idempotent. Pure function, exported for tests.
 */
export function groupSlackMessagesIntoDayPages(
  messages: SlackChannelMessage[],
): CollectorPage[] {
  return groupSlackMessagesIntoDatedDayPages(messages).map(
    (dated) => dated.page,
  );
}

/** A day page plus the bounds the watermark logic needs. */
type DatedSlackDayPage = {
  page: CollectorPage;
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  /** Newest message timestamp on this page, in epoch milliseconds. */
  maxTsMs: number;
};

/**
 * Same grouping, carrying each page's day and newest timestamp so the
 * collector can cap a tick without advancing its watermark past history it
 * did not actually write.
 */
function groupSlackMessagesIntoDatedDayPages(
  messages: SlackChannelMessage[],
): DatedSlackDayPage[] {
  const groups = new Map<
    string,
    {
      channelId: string;
      channelName: string;
      day: string;
      messages: Array<SlackChannelMessage & { at: Date }>;
    }
  >();

  for (const message of messages) {
    const at = slackTsToDate(message.ts);

    if (!at || !message.text.trim()) {
      continue;
    }

    const day = formatUtcDay(at);
    const key = `${message.channelId}/${day}`;
    const group = groups.get(key) ?? {
      channelId: message.channelId,
      channelName: message.channelName,
      day,
      messages: [],
    };

    group.messages.push({ ...message, at });
    groups.set(key, group);
  }

  return [...groups.values()]
    .sort(
      (a, b) =>
        // Oldest day first: a capped tick must keep the oldest history and
        // leave the newest for the next tick, so the watermark only ever
        // moves forward over pages that were actually written.
        a.day.localeCompare(b.day) ||
        a.channelName.localeCompare(b.channelName),
    )
    .map((group) => {
      const lines = group.messages
        .sort((a, b) => Number.parseFloat(a.ts) - Number.parseFloat(b.ts))
        .map(
          (message) =>
            `- [${formatUtcTime(message.at)}] <${message.userId ?? 'unknown'}>: ${message.text.trim()}`,
        );

      return {
        day: group.day,
        maxTsMs: Math.max(
          ...group.messages.map((message) => message.at.getTime()),
        ),
        page: {
          slug: `slack/${group.channelId}/${group.day}`,
          title: `#${group.channelName} — ${group.day}`,
          content: [
            `Slack public channel #${group.channelName} (${group.channelId}), messages on ${group.day} (times UTC).`,
            '',
            ...lines,
          ].join('\n'),
        },
      };
    });
}

/**
 * Cap a tick's day pages without losing the remainder.
 *
 * The engine advances a collector's watermark to whatever `nextSince` it
 * reports, and Slack's `oldest` filter is a timestamp, not a page cursor. So
 * reporting a watermark computed over messages whose pages were dropped by
 * the cap would skip them permanently. Cut on a whole-day boundary instead:
 * keep only complete days, and let the watermark land at the newest kept
 * message, which is strictly older than every dropped page's day.
 *
 * If one single day exceeds the cap on its own, cutting on a day boundary
 * would keep nothing and never progress. That case keeps a partial day and
 * reports no watermark, so the next tick re-reads the same window; the pages
 * are idempotent upserts, and the deep backfill is what carries real history.
 */
export function capSlackDayPagesForTick(
  dated: DatedSlackDayPage[],
  limit: number,
): { pages: CollectorPage[]; nextSince: Date | null } {
  if (dated.length <= limit) {
    const maxTsMs = dated.reduce(
      (max, entry) => Math.max(max, entry.maxTsMs),
      0,
    );

    return {
      pages: dated.map((entry) => entry.page),
      nextSince: maxTsMs > 0 ? new Date(maxTsMs) : null,
    };
  }

  const cutDay = dated[limit]!.day;
  const wholeDays = dated.filter((entry) => entry.day < cutDay);

  if (wholeDays.length === 0) {
    return {
      pages: dated.slice(0, limit).map((entry) => entry.page),
      nextSince: null,
    };
  }

  const maxTsMs = wholeDays.reduce(
    (max, entry) => Math.max(max, entry.maxTsMs),
    0,
  );

  return {
    pages: wholeDays.map((entry) => entry.page),
    nextSince: maxTsMs > 0 ? new Date(maxTsMs) : null,
  };
}

function getSlackErrorCode(error: unknown): string | null {
  const data = (error as { data?: { error?: unknown } } | null)?.data;

  return typeof data?.error === 'string' ? data.error : null;
}

type RawSlackMessage = {
  ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  type?: string;
  subtype?: string;
};

function toSlackChannelMessages(
  messages: RawSlackMessage[],
  channel: { id: string; name: string },
): SlackChannelMessage[] {
  const collected: SlackChannelMessage[] = [];

  for (const message of messages) {
    if (
      !message.ts ||
      (message.type && message.type !== 'message') ||
      (message.subtype && SLACK_SKIPPED_SUBTYPES.has(message.subtype)) ||
      !message.text?.trim() ||
      !slackTsToDate(message.ts)
    ) {
      continue;
    }

    collected.push({
      channelId: channel.id,
      channelName: channel.name,
      ts: message.ts,
      userId: message.user ?? message.bot_id ?? null,
      text: message.text,
    });
  }

  return collected;
}

async function listPublicMemberChannels(
  client: ReturnType<typeof createSlackWebClient>,
): Promise<Array<{ id: string; name: string }>> {
  const channels: Array<{ id: string; name: string }> = [];
  let cursor: string | undefined;

  for (let page = 0; page < SLACK_CHANNEL_LIST_MAX_PAGES; page++) {
    const response = await client.conversations.list({
      types: 'public_channel',
      exclude_archived: true,
      limit: SLACK_CHANNEL_LIST_PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    });

    for (const channel of response.channels ?? []) {
      if (
        channel.id &&
        channel.name &&
        channel.is_member === true &&
        channel.is_private !== true
      ) {
        channels.push({ id: channel.id, name: channel.name });
      }
    }

    cursor = response.response_metadata?.next_cursor || undefined;

    if (!cursor) {
      break;
    }
  }

  return channels;
}

async function collectSlackPublicChannelMessages(input: {
  since: Date | null;
  limit: number;
}): Promise<{ pages: CollectorPage[]; nextSince: Date | null }> {
  const installations = await db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.isActive, true));

  const collected: SlackChannelMessage[] = [];
  let scopeWarned = false;
  // Any channel we could not read leaves a hole in this window, so the
  // watermark stays put and the next pass asks for the same span again.
  let allChannelsRead = true;
  // With no watermark yet, read only a short recent window rather than
  // whatever 200 messages per channel happen to reach back to. History is the
  // deep backfill's job; letting the incremental pass drag in weeks of it is
  // what pushes a first tick past the page cap.
  const oldestMs = input.since
    ? input.since.getTime()
    : Date.now() - SLACK_FIRST_PASS_WINDOW_MS;
  const oldest = (oldestMs / 1000).toFixed(3);
  // Ask for a bounded slice, so a channel that is far behind is caught up over
  // successive ticks rather than read newest-first with a gap behind it.
  // Narrowed in place when a channel turns out too busy for the ask, so the
  // watermark only ever advances as far as every channel was read completely.
  let effectiveWindowMs = Math.min(
    SLACK_INCREMENTAL_WINDOW_MS,
    Math.max(0, Date.now() - oldestMs),
  );

  if (effectiveWindowMs <= 0) {
    // The watermark is already current. Nothing to ask for, and nothing to
    // advance: moving it now would step over messages not yet posted.
    return { pages: [], nextSince: null };
  }

  for (const installation of installations) {
    const client = createSlackWebClient(installation.botAccessToken);

    let channels: Array<{ id: string; name: string }>;
    try {
      channels = await listPublicMemberChannels(client);
    } catch (error) {
      const code = getSlackErrorCode(error);

      if (code === 'missing_scope' || code === 'invalid_auth') {
        console.warn(
          `${LOG_PREFIX} slack team ${installation.teamId}: conversations.list failed with ${code}; producing no pages (the app manifest may lack the channels:read scope)`,
        );
        continue;
      }

      throw error;
    }

    for (const channel of channels) {
      let messages: RawSlackMessage[];
      try {
        // Page the whole window rather than taking Slack's newest slice.
        // conversations.history returns newest-first, so reading one page of a
        // busy channel and advancing the watermark to that page's newest
        // message would step straight over everything older in the same
        // window, permanently once the deep backfill has finished.
        //
        // A channel too busy even for the page ceiling narrows the window
        // instead of losing the remainder: the ask halves until it fits, and
        // the pass advances only as far as the narrowest window every channel
        // completed. Channels that finished a wider window just read a little
        // ahead, which costs nothing because pages are idempotent.
        messages = [];

        for (;;) {
          const attemptLatest = ((oldestMs + effectiveWindowMs) / 1000).toFixed(
            3,
          );
          const attempt: RawSlackMessage[] = [];
          let cursor: string | undefined;
          let pages = 0;

          do {
            const history = await client.conversations.history({
              channel: channel.id,
              limit: SLACK_HISTORY_LIMIT_PER_CHANNEL,
              oldest,
              latest: attemptLatest,
              ...(cursor ? { cursor } : {}),
            });

            attempt.push(...(history.messages ?? []));
            cursor = history.response_metadata?.next_cursor || undefined;
            pages++;
          } while (cursor && pages < SLACK_INCREMENTAL_MAX_PAGES);

          if (!cursor) {
            messages = attempt;
            break;
          }

          if (effectiveWindowMs <= SLACK_MIN_WINDOW_MS) {
            // More than the page ceiling inside the smallest window worth
            // asking for. Keeping what was read is the only option left that
            // still makes progress, so say so plainly.
            console.warn(
              `${LOG_PREFIX} slack channel ${channel.id} exceeded ${SLACK_INCREMENTAL_MAX_PAGES} pages within ${SLACK_MIN_WINDOW_MS / 60000} minutes; some messages in that window are not ingested`,
            );
            messages = attempt;
            break;
          }

          effectiveWindowMs = Math.max(
            SLACK_MIN_WINDOW_MS,
            Math.floor(effectiveWindowMs / 2),
          );
        }
      } catch (error) {
        const code = getSlackErrorCode(error);

        if (code === 'missing_scope' || code === 'invalid_auth') {
          if (!scopeWarned) {
            console.warn(
              `${LOG_PREFIX} slack team ${installation.teamId}: conversations.history failed with ${code}; producing no pages for this team (the app manifest likely lacks the channels:history scope)`,
            );
            scopeWarned = true;
          }

          allChannelsRead = false;

          if (code === 'invalid_auth') {
            break;
          }

          continue;
        }

        console.warn(
          `${LOG_PREFIX} slack channel ${channel.id} history read failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        allChannelsRead = false;
        continue;
      }

      collected.push(...toSlackChannelMessages(messages, channel));
    }
  }

  const dated = groupSlackMessagesIntoDatedDayPages(collected);
  const capped = capSlackDayPagesForTick(dated, input.limit);
  const windowEndMs = oldestMs + effectiveWindowMs;

  // Two limits can bite in the same pass, and only one of them may move the
  // watermark. The page cap defers whole channel-days to the next tick and
  // reports how far it got; overriding that with the end of the time window
  // would step straight over what it just deferred. So the window end applies
  // only when nothing was held back.
  if (!allChannelsRead) {
    // A channel we could not read leaves a hole anywhere in this window, so
    // the watermark cannot move at all. Returning what the cap computed would
    // still advance it to the newest message the working channels produced,
    // stepping over the unread one.
    return { ...capped, nextSince: null };
  }

  if (dated.length > capped.pages.length) {
    // The cap deferred whole channel-days. Its own nextSince already stops
    // short of them, so it stands rather than being widened below.
    return capped;
  }

  // Otherwise advance to the end of the window that was asked for, not merely
  // to the newest message seen, so a quiet window still makes progress instead
  // of stalling on channels with nothing to say.
  return { ...capped, nextSince: new Date(windowEndMs) };
}

/** Deep backfill reaches back this far through channel history. */
const SLACK_BACKFILL_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Durable backfill position, JSON-encoded into the single backfillCursor
 * string.
 *
 * `completed` is the set of channels whose history has been read, rather than
 * a high-water mark over a sorted walk. That distinction is the point: a bot
 * added to a channel next month is a channel that has never been backfilled,
 * and a positional cursor that had already walked past its name would never
 * come back for it. Membership is re-discovered every pass, so a new channel
 * simply shows up missing from this set and gets its history.
 *
 * `key` is `${teamId}/${channelId}`; `slackCursor` is Slack's own
 * response_metadata.next_cursor part-way through one channel's history.
 */
type SlackBackfillCursorState = {
  completed: string[];
  key: string | null;
  slackCursor: string | null;
};

function parseSlackBackfillCursor(
  raw: string | null,
): SlackBackfillCursorState | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;

    if (parsed) {
      return {
        completed: Array.isArray(parsed.completed)
          ? parsed.completed.filter(
              (entry): entry is string => typeof entry === 'string',
            )
          : [],
        key: typeof parsed.key === 'string' ? parsed.key : null,
        slackCursor:
          typeof parsed.slackCursor === 'string' ? parsed.slackCursor : null,
      };
    }
  } catch {
    // Unreadable cursor: restart the backfill; slugs are idempotent upserts.
  }

  return null;
}

/**
 * One backfill step: one `conversations.history` page of one channel, paged
 * backwards with Slack's cursor and floored at now minus 90 days. Channel
 * membership is re-discovered every pass; a channel that vanished mid-backfill
 * is skipped by resuming at the next sorted key.
 */
async function backfillSlackHistoryStep(rawCursor: string | null): Promise<{
  pages: CollectorPage[];
  nextCursor: string | null;
  done: boolean;
}> {
  const noProgress = { pages: [], nextCursor: rawCursor, done: false };
  const installations = await db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.isActive, true));

  const entries: Array<{
    key: string;
    channelId: string;
    channelName: string;
    client: ReturnType<typeof createSlackWebClient>;
  }> = [];

  for (const installation of installations) {
    const client = createSlackWebClient(installation.botAccessToken);

    try {
      for (const channel of await listPublicMemberChannels(client)) {
        entries.push({
          key: `${installation.teamId}/${channel.id}`,
          channelId: channel.id,
          channelName: channel.name,
          client,
        });
      }
    } catch (error) {
      const code = getSlackErrorCode(error);

      if (code === 'missing_scope' || code === 'invalid_auth') {
        console.warn(
          `${LOG_PREFIX} slack team ${installation.teamId}: backfill channel listing failed with ${code}; will retry next tick`,
        );
        continue;
      }

      throw error;
    }
  }

  if (entries.length === 0) {
    // No member channels yet, which is a state to sit in rather than a
    // finished backfill: the bot being added to its first channel tomorrow
    // has to be noticed. Holding position costs one listing per pass.
    return noProgress;
  }

  entries.sort((a, b) => a.key.localeCompare(b.key));

  const state = parseSlackBackfillCursor(rawCursor);
  const completed = new Set(state?.completed ?? []);

  // Resume the channel that was part-way done, otherwise take the first that
  // has never been read. Both cases fall out of the completed set.
  let entry = state?.key
    ? entries.find((candidate) => candidate.key === state.key)
    : undefined;
  const slackCursor = entry ? (state?.slackCursor ?? null) : null;

  if (!entry) {
    entry = entries.find((candidate) => !completed.has(candidate.key));
  }

  if (!entry) {
    // Every known channel has been read. Deliberately not reported as done:
    // done is permanent, and this collector has to stay reachable so that a
    // channel joined later is noticed. The cost of staying open is one
    // channel listing per pass, and returning the cursor unchanged with no
    // pages ends the tick immediately.
    return {
      pages: [],
      nextCursor: JSON.stringify({
        completed: [...completed].sort(),
        key: null,
        slackCursor: null,
      }),
      done: false,
    };
  }
  const oldest = ((Date.now() - SLACK_BACKFILL_WINDOW_MS) / 1000).toFixed(3);

  let messages: RawSlackMessage[];
  let nextSlackCursor: string | null;
  try {
    const history = await entry.client.conversations.history({
      channel: entry.channelId,
      limit: SLACK_HISTORY_LIMIT_PER_CHANNEL,
      oldest,
      ...(slackCursor ? { cursor: slackCursor } : {}),
    });

    messages = history.messages ?? [];
    nextSlackCursor = history.response_metadata?.next_cursor || null;
  } catch (error) {
    const code = getSlackErrorCode(error);

    if (code === 'missing_scope' || code === 'invalid_auth') {
      console.warn(
        `${LOG_PREFIX} slack backfill of channel ${entry.channelId} failed with ${code}; will retry next tick (the app manifest likely lacks the channels:history scope)`,
      );
      return noProgress;
    }

    throw error;
  }

  const pages = groupSlackMessagesIntoDayPages(
    toSlackChannelMessages(messages, {
      id: entry.channelId,
      name: entry.channelName,
    }),
  );

  if (nextSlackCursor) {
    return {
      pages,
      nextCursor: JSON.stringify({
        completed: [...completed].sort(),
        key: entry.key,
        slackCursor: nextSlackCursor,
      }),
      done: false,
    };
  }

  // This channel is fully read. Recording it is what lets the next pass move
  // on, and what keeps a channel joined later distinguishable from one already
  // done.
  completed.add(entry.key);

  return {
    pages,
    nextCursor: JSON.stringify({
      completed: [...completed].sort(),
      key: null,
      slackCursor: null,
    }),
    done: false,
  };
}

/** Exported for the fake-Slack integration test, which drives it directly. */
export const slackPublicChannelsCollector: BrainCollector = {
  id: 'slack-public-channels',
  displayName: 'Slack public channels',
  async isEnabled() {
    const installation = await db.query.slackInstallations.findFirst({
      columns: { id: true },
      where: eq(slackInstallations.isActive, true),
    });

    return Boolean(installation);
  },
  async collect({ since, limit }) {
    return collectSlackPublicChannelMessages({ since, limit });
  },
  async backfill({ cursor }) {
    return backfillSlackHistoryStep(cursor);
  },
};

/**
 * Granola: meeting notes
 * ----------------------
 *
 * Minimal REST client against Granola's public API using the admin-configured
 * deployment credential (same connection the Granola MCP handler resolves).
 * Bounded: first pass takes the most recent ~50 notes; later passes filter
 * with `updated_after` from the watermark.
 */

const GRANOLA_API_BASE_URL = 'https://public-api.granola.ai';
const GRANOLA_PAGE_SIZE = 30; // Granola's documented per-page maximum.
const GRANOLA_MAX_NOTES_PER_TICK = 50;
/** Enough to page to the note ceiling, with headroom for short pages. */
const GRANOLA_MAX_REQUESTS_PER_TICK = 10;

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function parseDate(value: unknown): Date | null {
  const raw = asString(value);

  if (!raw) {
    return null;
  }

  const parsed = new Date(raw);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function slugifySegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

function extractAttendees(note: Record<string, unknown>): string[] {
  const raw = note.attendees ?? note.people ?? note.participants;

  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((entry) => {
      if (typeof entry === 'string') {
        return entry.trim();
      }

      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;

        return asString(record.name) ?? asString(record.email) ?? '';
      }

      return '';
    })
    .filter(Boolean);
}

const GRANOLA_NOTE_EXCERPT_MAX_CHARS = 3000;

/**
 * Map one Granola note object to a memory page. Defensive by design: the
 * exact response shape is not contract-pinned, so unknown shapes produce
 * `null` (zero pages) instead of throwing. Pure function, exported for tests.
 */
export function buildGranolaMeetingPage(
  note: unknown,
): { page: CollectorPage; updatedAt: Date | null } | null {
  if (!note || typeof note !== 'object') {
    return null;
  }

  const record = note as Record<string, unknown>;
  const id = asString(record.id);
  const title = asString(record.title) ?? 'Untitled meeting';

  if (!id && !asString(record.title)) {
    return null;
  }

  const createdAt = parseDate(record.created_at) ?? parseDate(record.createdAt);
  const updatedAt =
    parseDate(record.updated_at) ?? parseDate(record.updatedAt) ?? createdAt;
  const day = createdAt ? formatUtcDay(createdAt) : 'undated';
  const slugTail = slugifySegment(title) || id || 'meeting';
  const attendees = extractAttendees(record);
  const body =
    asString(record.summary) ??
    asString(record.overview) ??
    asString(record.notes_markdown) ??
    asString(record.notes_plain) ??
    asString(record.notes) ??
    asString(record.content) ??
    '';
  const excerpt = body.slice(0, GRANOLA_NOTE_EXCERPT_MAX_CHARS);

  const content = [
    '---',
    ...(id ? [`granola_note_id: ${id}`] : []),
    `date: ${day}`,
    'provenance: roomote-granola-meetings',
    '---',
    '',
    `# ${title}`,
    '',
    `Meeting on ${day}.`,
    ...(attendees.length > 0
      ? ['', '## Attendees', '', ...attendees.map((name) => `- ${name}`)]
      : []),
    ...(excerpt ? ['', '## Notes', '', excerpt] : []),
    '',
  ].join('\n');

  return {
    page: { slug: `meetings/${day}-${slugTail}`, title, content },
    updatedAt,
  };
}

async function findGranolaConnectionConfig(): Promise<McpConnectionGranolaConfig | null> {
  const connection = await db.query.mcpConnections.findFirst({
    where: and(
      eq(mcpConnections.mcpId, 'granola'),
      isNull(mcpConnections.userId),
      eq(mcpConnections.enabled, true),
      eq(mcpConnections.authStatus, 'authenticated'),
    ),
  });

  return isMcpConnectionGranolaConfig(connection?.authConfig)
    ? connection.authConfig
    : null;
}

async function collectGranolaMeetings(input: {
  since: Date | null;
  limit: number;
}): Promise<{ pages: CollectorPage[]; nextSince: Date | null }> {
  const config = await findGranolaConnectionConfig();

  if (!config) {
    return { pages: [], nextSince: null };
  }

  const apiKey = decrypt(config.encryptedApiKey).trim();

  if (!apiKey) {
    console.warn(
      `${LOG_PREFIX} granola connection has an empty stored API key; producing no pages`,
    );
    return { pages: [], nextSince: null };
  }

  const notes: unknown[] = [];
  let cursor: string | null = null;
  let requests = 0;

  // Bounded by requests as well as notes: an upstream that keeps answering
  // "more pages" while returning none would otherwise spin here forever.
  while (
    notes.length < GRANOLA_MAX_NOTES_PER_TICK &&
    requests < GRANOLA_MAX_REQUESTS_PER_TICK
  ) {
    requests++;
    const url = new URL('v1/notes', `${GRANOLA_API_BASE_URL}/`);

    url.searchParams.set('page_size', String(GRANOLA_PAGE_SIZE));

    if (input.since) {
      url.searchParams.set('updated_after', input.since.toISOString());
    }

    if (cursor) {
      url.searchParams.set('cursor', cursor);
    }

    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (response.status === 401 || response.status === 403) {
      console.warn(
        `${LOG_PREFIX} granola rejected the stored API key (${response.status}); producing no pages`,
      );
      return { pages: [], nextSince: null };
    }

    if (!response.ok) {
      console.warn(
        `${LOG_PREFIX} granola list-notes failed with status ${response.status}; using ${notes.length} notes fetched so far`,
      );
      break;
    }

    const payload = (await response.json().catch(() => null)) as {
      notes?: unknown[];
      hasMore?: boolean;
      cursor?: string | null;
    } | null;

    if (!payload || !Array.isArray(payload.notes)) {
      console.warn(
        `${LOG_PREFIX} granola list-notes returned an unexpected payload shape; producing no further pages`,
      );
      break;
    }

    notes.push(...payload.notes);
    cursor = payload.hasMore && payload.cursor ? payload.cursor : null;

    if (!cursor) {
      break;
    }
  }

  const pages: CollectorPage[] = [];
  let nextSince: Date | null = null;

  for (const note of notes.slice(0, GRANOLA_MAX_NOTES_PER_TICK)) {
    const mapped = buildGranolaMeetingPage(note);

    if (!mapped) {
      continue;
    }

    pages.push(mapped.page);

    if (mapped.updatedAt && (!nextSince || mapped.updatedAt > nextSince)) {
      nextSince = mapped.updatedAt;
    }
  }

  return { pages: pages.slice(0, input.limit), nextSince };
}

/**
 * One backfill step: one API page of the full note history (no
 * `updated_after` filter). The durable backfillCursor is Granola's own
 * pagination cursor; done when the API stops returning one.
 */
async function backfillGranolaNotesStep(cursor: string | null): Promise<{
  pages: CollectorPage[];
  nextCursor: string | null;
  done: boolean;
}> {
  const noProgress = { pages: [], nextCursor: cursor, done: false };
  const config = await findGranolaConnectionConfig();

  if (!config) {
    return noProgress;
  }

  const apiKey = decrypt(config.encryptedApiKey).trim();

  if (!apiKey) {
    console.warn(
      `${LOG_PREFIX} granola connection has an empty stored API key; backfill will retry next tick`,
    );
    return noProgress;
  }

  const url = new URL('v1/notes', `${GRANOLA_API_BASE_URL}/`);

  url.searchParams.set('page_size', String(GRANOLA_PAGE_SIZE));

  if (cursor) {
    url.searchParams.set('cursor', cursor);
  }

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    console.warn(
      `${LOG_PREFIX} granola backfill list-notes failed with status ${response.status}; will retry next tick`,
    );
    return noProgress;
  }

  const payload = (await response.json().catch(() => null)) as {
    notes?: unknown[];
    hasMore?: boolean;
    cursor?: string | null;
  } | null;

  if (!payload || !Array.isArray(payload.notes)) {
    console.warn(
      `${LOG_PREFIX} granola backfill list-notes returned an unexpected payload shape; will retry next tick`,
    );
    return noProgress;
  }

  const pages: CollectorPage[] = [];

  for (const note of payload.notes) {
    const mapped = buildGranolaMeetingPage(note);

    if (mapped) {
      pages.push(mapped.page);
    }
  }

  const nextCursor = payload.hasMore && payload.cursor ? payload.cursor : null;

  return { pages, nextCursor, done: !nextCursor };
}

const granolaMeetingsCollector: BrainCollector = {
  id: 'granola-meetings',
  displayName: 'Granola meeting notes',
  async isEnabled() {
    return Boolean(await findGranolaConnectionConfig());
  },
  async collect({ since, limit }) {
    return collectGranolaMeetings({ since, limit });
  },
  async backfill({ cursor }) {
    return backfillGranolaNotesStep(cursor);
  },
};

/**
 * GitHub issues: the bug reports, feature discussions, and decisions that the
 * merged-PR facts mirror (prs/ pages) does not carry. Reads use the
 * deployment's own GitHub App installation, so the corpus stays within what
 * Roomote can already see in connected repositories. All upstream failures
 * are absorbed in the SDK layer as no-progress results, so a GitHub rate
 * limit can never masquerade as brain-side backpressure.
 */
const githubIssuesCollector: BrainCollector = {
  id: 'github-issues',
  displayName: 'GitHub issues',
  async isEnabled() {
    return hasBrainGithubSources();
  },
  async collect({ since, limit }) {
    return collectBrainGithubIssues({ since, limit });
  },
  async backfill({ cursor }) {
    return backfillBrainGithubIssuesStep({ cursor });
  },
};

const BRAIN_COLLECTORS: BrainCollector[] = [
  slackPublicChannelsCollector,
  granolaMeetingsCollector,
  githubIssuesCollector,
];
