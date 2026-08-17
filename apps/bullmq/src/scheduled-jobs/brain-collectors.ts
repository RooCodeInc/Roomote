import {
  and,
  db,
  deploymentMcpEnablements,
  deleteBrainCollectorItems,
  discordUserMappings,
  eq,
  getBrainSyncState,
  githubUserMappings,
  inArray,
  isNull,
  listBrainCollectorItems,
  listBrainCollectorItemsBefore,
  mcpConnections,
  slackDirectoryUsers,
  slackInstallations,
  slackUserMappings,
  sourceControlUserMappings,
  teamsUserMappings,
  telegramUserMappings,
  upsertBrainSyncState,
  upsertBrainCollectorItems,
  users,
} from '@roomote/db/server';
import { decrypt } from '@roomote/db/encryption';
import { createHash } from 'node:crypto';
import {
  backfillBrainGithubIssuesStep,
  collectBrainGithubIssues,
  hasBrainGithubSources,
} from '@roomote/sdk/server';
import {
  NotionApiError,
  notionApiRequestJson,
} from '@roomote/sdk/server/notion-api';
import { ripplingApiRequestJson } from '@roomote/sdk/server/rippling-api';
import { createSlackWebClient } from '@roomote/slack';
import {
  isMcpConnectionGranolaConfig,
  isMcpConnectionNotionConfig,
  isMcpConnectionRipplingConfig,
  type McpConnectionGranolaConfig,
  type McpConnectionNotionConfig,
  type McpConnectionRipplingConfig,
} from '@roomote/types';

import {
  isBrainNotReady,
  isBrainRateLimited,
  postToBrain,
  redactBrainText,
} from './brain-outbox-drain';

const LOG_PREFIX = '[brainCollectors]';

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

export type CollectorPage = {
  slug: string;
  title: string;
  content: string;
};

type CollectorStateUpdate = {
  collectorId: string;
  watermark?: Date;
  /** Optional opaque incremental cursor stored on the partition's state row. */
  cursor?: string | null;
  /** Optional deep-backfill completion reset for dependent projections. */
  backfillCompletedAt?: Date | null;
};

type CollectorItemUpdate = {
  collectorId: string;
  itemId: string;
  slug: string;
  lastSeenAt: Date;
};

type CollectorItemDelete = {
  collectorId: string;
  itemIds: string[];
};

export type CollectorResult = {
  pages: CollectorPage[];
  nextSince: Date | null;
  /**
   * Partition-specific progress for collectors that fan out over independent
   * upstream sources. The engine persists these only after every returned
   * page lands, preserving the same outbox-like ordering as `nextSince`.
   */
  stateUpdates?: CollectorStateUpdate[];
  /** Inventory changes persist only after every returned page lands. */
  itemUpdates?: CollectorItemUpdate[];
  itemDeletes?: CollectorItemDelete[];
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

type BrainCollectorRunResult = {
  /** At least one durable deep-backfill cursor advanced in this pass. */
  backfillProgressed: boolean;
  /** Stop fast continuation and wait for the normal scheduled retry. */
  interrupted: boolean;
};

export interface BrainCollector {
  id: string;
  displayName: string;
  isEnabled(): Promise<boolean>;
  collect(input: {
    since: Date | null;
    now: Date;
    limit: number;
  }): Promise<CollectorResult>;
  /**
   * Optional initial deep backfill over a longer history window, drained in
   * bounded steps across ticks. `cursor` is the collector's own opaque
   * resume token (persisted durably between passes); `done: true` marks the
   * backfill finished forever. A step that returns zero pages with an
   * unchanged cursor signals "no progress" (e.g. upstream auth trouble) and
   * ends this pass's backfill without marking it done.
   */
  backfill?(input: { cursor: string | null; limit: number }): Promise<{
    pages: CollectorPage[];
    nextCursor: string | null;
    done: boolean;
    itemUpdates?: CollectorItemUpdate[];
  }>;
}

type BrainConnection = { baseUrl: string; token: string };

export type BrainSink = (
  page: CollectorPage,
  connection: BrainConnection,
) => Promise<void>;

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
    collectors?: BrainCollector[];
    /** Skip upstream incremental polls during fast historical continuation. */
    includeIncremental?: boolean;
  } = {},
): Promise<BrainCollectorRunResult> {
  const sink = options.sink ?? postToBrain;
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
        } = await collector.collect({
          since: state?.watermark ?? null,
          now: new Date(),
          limit: MAX_PAGES_PER_COLLECTOR_PER_PASS,
        });
        const overshot = pages.length > MAX_PAGES_PER_COLLECTOR_PER_PASS;
        const capped = pages.slice(0, MAX_PAGES_PER_COLLECTOR_PER_PASS);

        for (const page of capped) {
          await sink(
            { ...page, content: redactBrainText(page.content) },
            connection,
          );
        }

        if (overshot) {
          console.warn(
            `${LOG_PREFIX} ${collector.id} returned ${pages.length} pages over a limit of ${MAX_PAGES_PER_COLLECTOR_PER_PASS}; holding its watermark so the remainder is re-collected`,
          );
        }

        // Advance only after every page landed; a mid-batch failure leaves the
        // watermark behind so the next tick retries the same idempotent slugs.
        if (nextSince && !overshot) {
          await upsertBrainSyncState(db, collector.id, {
            watermark: nextSince,
          });
        }

        if (!overshot) {
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
}): Promise<boolean> {
  const { collectorId, backfill, startCursor, connection, sink } = input;
  let cursor = startCursor;
  let budget = MAX_BACKFILL_PAGES_PER_COLLECTOR_PER_PASS;
  let steps = 0;
  let ingested = 0;

  while (budget > 0 && steps < MAX_BACKFILL_STEPS_PER_COLLECTOR_PER_PASS) {
    steps++;
    const step = await backfill({ cursor, limit: budget });

    for (const page of step.pages) {
      await sink(
        { ...page, content: redactBrainText(page.content) },
        connection,
      );
    }

    await persistCollectorItemUpdates(step.itemUpdates ?? []);

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
  teamId: string;
  channelId: string;
  channelName: string;
  /** Slack message ts, e.g. "1723500000.123456". */
  ts: string;
  userId: string | null;
  userLabel?: string;
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

/** Smallest incremental slice. A source that still exceeds the request cap
 * holds only its own watermark; unrelated channels continue independently. */
const SLACK_MIN_WINDOW_MS = 1000;
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
 * Group one fetched Slack batch into immutable channel/day chunks. Timestamp
 * bounds are part of the slug, so a later tick cannot replace an earlier
 * partial day. Replaying the same upstream batch remains idempotent.
 */
export function groupSlackMessagesIntoDayPages(
  messages: SlackChannelMessage[],
): CollectorPage[] {
  const groups = new Map<
    string,
    {
      channelId: string;
      channelName: string;
      teamId: string;
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
    const key = `${message.teamId}/${message.channelId}/${day}`;
    const group = groups.get(key) ?? {
      teamId: message.teamId,
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
        a.day.localeCompare(b.day) ||
        a.teamId.localeCompare(b.teamId) ||
        a.channelName.localeCompare(b.channelName),
    )
    .flatMap((group) => {
      const sortedMessages = group.messages.sort(
        (a, b) => Number.parseFloat(a.ts) - Number.parseFloat(b.ts),
      );
      const pages: CollectorPage[] = [];

      for (
        let start = 0;
        start < sortedMessages.length;
        start += SLACK_HISTORY_LIMIT_PER_CHANNEL
      ) {
        const chunk = sortedMessages.slice(
          start,
          start + SLACK_HISTORY_LIMIT_PER_CHANNEL,
        );
        const lines = chunk.map(
          (message) =>
            `- [${formatUtcTime(message.at)}] <${
              message.userLabel && message.userId
                ? `${message.userLabel} (${message.userId})`
                : (message.userId ?? 'unknown')
            }>: ${message.text.trim()}`,
        );
        const firstTs = chunk[0]!.ts.replace('.', '-');
        const lastTs = chunk.at(-1)!.ts.replace('.', '-');

        pages.push({
          slug: `slack/${group.teamId}/${group.channelId}/${group.day}/${firstTs}-${lastTs}`,
          title: `#${group.channelName} — ${group.day}`,
          content: [
            '---',
            `date: ${group.day}`,
            '---',
            '',
            `Slack public channel #${group.channelName} (${group.channelId}), messages on ${group.day} (times UTC).`,
            '',
            ...lines,
          ].join('\n'),
        });
      }

      return pages;
    });
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
  channel: { id: string; name: string; teamId: string },
  userLabels: ReadonlyMap<string, string> = new Map(),
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
      teamId: channel.teamId,
      channelId: channel.id,
      channelName: channel.name,
      ts: message.ts,
      userId: message.user ?? message.bot_id ?? null,
      userLabel: message.user
        ? userLabels.get(`${channel.teamId}/${message.user}`)
        : undefined,
      text: message.text,
    });
  }

  return collected;
}

async function loadSlackAuthorLabels(): Promise<Map<string, string>> {
  try {
    const mappings = await db.query.slackUserMappings.findMany({
      with: { user: { columns: { name: true } } },
    });

    return new Map(
      mappings
        .filter((mapping) => brainSafeIdentityValue(mapping.user.name))
        .map((mapping) => [
          `${mapping.slackTeamId}/${mapping.slackUserId}`,
          brainSafeIdentityValue(mapping.user.name),
        ]),
    );
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} could not resolve Slack author names: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return new Map();
  }
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
  now: Date;
  limit: number;
}): Promise<CollectorResult> {
  const userLabels = await loadSlackAuthorLabels();
  const installations = await db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.isActive, true));

  const entries: Array<{
    key: string;
    stateId: string;
    teamId: string;
    channel: { id: string; name: string };
    client: ReturnType<typeof createSlackWebClient>;
  }> = [];
  let scopeWarned = false;

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
      const key = `${installation.teamId}/${channel.id}`;
      entries.push({
        key,
        stateId: `${slackPublicChannelsCollector.id}:${key}`,
        teamId: installation.teamId,
        channel,
        client,
      });
    }
  }

  const entriesWithState = await Promise.all(
    entries.map(async (entry) => ({
      ...entry,
      state: await getBrainSyncState(db, entry.stateId),
    })),
  );

  // Oldest partitions go first so a continuously busy channel cannot starve
  // another channel when the shared per-pass page budget is exhausted.
  entriesWithState.sort(
    (a, b) =>
      (a.state?.watermark?.getTime() ?? 0) -
        (b.state?.watermark?.getTime() ?? 0) || a.key.localeCompare(b.key),
  );

  const pages: CollectorPage[] = [];
  const stateUpdates: CollectorStateUpdate[] = [];
  const nowMs = input.now.getTime();

  for (const entry of entriesWithState) {
    const savedWatermarkMs = entry.state?.watermark?.getTime();
    const oldestMs = Math.min(
      savedWatermarkMs ?? nowMs - SLACK_FIRST_PASS_WINDOW_MS,
      nowMs,
    );
    let effectiveWindowMs = Math.min(
      SLACK_INCREMENTAL_WINDOW_MS,
      Math.max(0, nowMs - oldestMs),
    );

    if (effectiveWindowMs <= 0) {
      if (savedWatermarkMs && savedWatermarkMs > nowMs) {
        stateUpdates.push({
          collectorId: entry.stateId,
          watermark: input.now,
        });
      }
      continue;
    }

    let messages: RawSlackMessage[] = [];
    let complete = false;

    try {
      for (;;) {
        const oldest = (oldestMs / 1000).toFixed(3);
        const latest = ((oldestMs + effectiveWindowMs) / 1000).toFixed(3);
        const attempt: RawSlackMessage[] = [];
        let cursor: string | undefined;
        let requestPages = 0;

        do {
          const history = await entry.client.conversations.history({
            channel: entry.channel.id,
            limit: SLACK_HISTORY_LIMIT_PER_CHANNEL,
            oldest,
            latest,
            ...(cursor ? { cursor } : {}),
          });

          attempt.push(...(history.messages ?? []));
          cursor = history.response_metadata?.next_cursor || undefined;
          requestPages++;
        } while (cursor && requestPages < SLACK_INCREMENTAL_MAX_PAGES);

        if (!cursor) {
          messages = attempt;
          complete = true;
          break;
        }

        if (effectiveWindowMs <= SLACK_MIN_WINDOW_MS) {
          // This partition alone holds position. Other channels have their
          // own watermarks and continue; immutable chunk slugs make retrying
          // the fetched subset harmless until cursor persistence is added.
          console.warn(
            `${LOG_PREFIX} slack channel ${entry.channel.id} exceeded ${SLACK_INCREMENTAL_MAX_PAGES} pages within ${SLACK_MIN_WINDOW_MS / 1000} second; holding this channel's watermark`,
          );
          // Do not spend the page budget on a partial prefix that cannot move
          // its checkpoint and would be re-written on every tick.
          messages = [];
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
            `${LOG_PREFIX} slack team ${entry.key.split('/')[0]}: conversations.history failed with ${code}; holding affected channel watermarks (the app manifest likely lacks the channels:history scope)`,
          );
          scopeWarned = true;
        }
      } else {
        console.warn(
          `${LOG_PREFIX} slack channel ${entry.channel.id} history read failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      continue;
    }

    const channelPages = groupSlackMessagesIntoDayPages(
      toSlackChannelMessages(
        messages,
        {
          ...entry.channel,
          teamId: entry.teamId,
        },
        userLabels,
      ),
    );

    if (pages.length + channelPages.length > input.limit) {
      // This partition could not fit, but smaller partitions may still use
      // the remaining budget. Its watermark stays behind for the next pass.
      continue;
    }

    pages.push(...channelPages);

    if (complete) {
      stateUpdates.push({
        collectorId: entry.stateId,
        watermark: new Date(oldestMs + effectiveWindowMs),
      });
    }
  }

  return { pages, nextSince: null, stateUpdates };
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
  /** Stable upper bound for the current channel, excluding incremental data. */
  latest: string | null;
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
        latest: typeof parsed.latest === 'string' ? parsed.latest : null,
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
  const userLabels = await loadSlackAuthorLabels();
  const noProgress = { pages: [], nextCursor: rawCursor, done: false };
  const installations = await db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.isActive, true));

  const entries: Array<{
    key: string;
    channelId: string;
    channelName: string;
    teamId: string;
    client: ReturnType<typeof createSlackWebClient>;
  }> = [];

  for (const installation of installations) {
    const client = createSlackWebClient(installation.botAccessToken);

    try {
      for (const channel of await listPublicMemberChannels(client)) {
        entries.push({
          key: `${installation.teamId}/${channel.id}`,
          teamId: installation.teamId,
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
        latest: null,
      }),
      done: false,
    };
  }
  const resuming = entry.key === state?.key;
  const slackCursor = resuming ? (state?.slackCursor ?? null) : null;
  const latest = resuming
    ? (state?.latest ??
      ((Date.now() - SLACK_FIRST_PASS_WINDOW_MS) / 1000).toFixed(3))
    : ((Date.now() - SLACK_FIRST_PASS_WINDOW_MS) / 1000).toFixed(3);
  const oldest = ((Date.now() - SLACK_BACKFILL_WINDOW_MS) / 1000).toFixed(3);

  let messages: RawSlackMessage[];
  let nextSlackCursor: string | null;
  try {
    const history = await entry.client.conversations.history({
      channel: entry.channelId,
      limit: SLACK_HISTORY_LIMIT_PER_CHANNEL,
      oldest,
      ...(latest ? { latest } : {}),
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
    toSlackChannelMessages(
      messages,
      {
        id: entry.channelId,
        name: entry.channelName,
        teamId: entry.teamId,
      },
      userLabels,
    ),
  );

  if (nextSlackCursor) {
    return {
      pages,
      nextCursor: JSON.stringify({
        completed: [...completed].sort(),
        key: entry.key,
        slackCursor: nextSlackCursor,
        latest,
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
      latest: null,
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
  async collect({ now, limit }) {
    return collectSlackPublicChannelMessages({ now, limit });
  },
  async backfill({ cursor }) {
    return backfillSlackHistoryStep(cursor);
  },
};

/**
 * Deployment members: canonical person cards derived from Roomote identity
 * mappings. Postgres stays authoritative; these pages are a rebuildable search
 * projection containing names and provider handles, never email addresses.
 */

type PersonIdentityProvider = {
  provider: string;
  identifier: string;
  display?: string | null;
  title?: string | null;
  updatedAt: Date;
};

export type PersonIdentityRecord = {
  userId: string;
  name: string;
  email: string;
  role: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  providers: PersonIdentityProvider[];
};

type PersonIdentityReference = {
  slug: string;
  title: string;
  effectiveDate?: Date;
};

const LEGACY_SETUP_BOOTSTRAP_USER_ID = 'setup-bootstrap-user';

function personIdentitySlug(userId: string): string {
  const digest = createHash('sha256').update(userId).digest('hex').slice(0, 16);
  return `people/roomote-member-${digest}`;
}

function normalizeIdentityAlias(value: string): string {
  return singleLineIdentityValue(value).toLocaleLowerCase();
}

function singleLineIdentityValue(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

const IDENTITY_EMAIL_PATTERN =
  /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi;

function brainSafeIdentityValue(value: string): string {
  return singleLineIdentityValue(value)
    .replace(IDENTITY_EMAIL_PATTERN, '')
    .replace(/<\s*>|\(\s*\)|\[\s*\]|\{\s*\}/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:|/\\<>(){}\-–—]+|[\s,;:|/\\<>(){}\-–—]+$/g, '')
    .trim();
}

function personIdentityDisplayName(record: PersonIdentityRecord): string {
  return brainSafeIdentityValue(record.name) || 'Roomote member';
}

function personIdentityAliases(record: PersonIdentityRecord): string[] {
  const aliases = new Map<string, string>();
  const add = (value: string | null | undefined) => {
    const trimmed = value ? brainSafeIdentityValue(value) : '';
    if (trimmed) {
      aliases.set(normalizeIdentityAlias(trimmed), trimmed);
    }
  };

  add(record.name);
  for (const provider of record.providers) {
    add(provider.identifier);
    add(provider.display);
  }

  return [...aliases.values()].sort((a, b) => a.localeCompare(b));
}

export function buildPersonIdentityPage(
  record: PersonIdentityRecord,
): CollectorPage {
  const deleted = Boolean(record.deletedAt);
  const name = personIdentityDisplayName(record);
  const aliases = deleted ? [] : personIdentityAliases(record);
  const providers = deleted
    ? []
    : [...record.providers]
        .filter(({ identifier }) => brainSafeIdentityValue(identifier))
        .sort(
          (a, b) =>
            a.provider.localeCompare(b.provider) ||
            a.identifier.localeCompare(b.identifier),
        );
  const jobTitle = providers
    .map(({ title }) => brainSafeIdentityValue(title ?? ''))
    .find(Boolean);

  return {
    slug: personIdentitySlug(record.userId),
    title: name,
    content: [
      '---',
      'type: person',
      `aliases: ${JSON.stringify(aliases)}`,
      `status: ${deleted ? 'deleted' : 'active'}`,
      `event_date: ${formatUtcDay(record.createdAt)}`,
      ...(jobTitle ? [`job_title: ${JSON.stringify(jobTitle)}`] : []),
      'provenance: roomote-person-identities',
      '---',
      '',
      `# ${name}`,
      '',
      deleted
        ? 'This former Roomote member is no longer active.'
        : `Roomote deployment member with the ${record.role} role.`,
      `Joined Roomote on ${formatUtcDay(record.createdAt)}.`,
      ...(providers.length > 0
        ? [
            '',
            '## Linked identities',
            '',
            ...providers.map(({ provider, identifier, display, title }) => {
              const safeProvider = brainSafeIdentityValue(provider);
              const safeIdentifier = brainSafeIdentityValue(identifier);
              const safeDisplay = display
                ? brainSafeIdentityValue(display)
                : '';
              const safeTitle = title ? brainSafeIdentityValue(title) : '';
              return `- ${safeProvider}: ${safeDisplay ? `${safeDisplay} (${safeIdentifier})` : safeIdentifier}${safeTitle ? ` — ${safeTitle}` : ''}`;
            }),
          ]
        : []),
      '',
    ].join('\n'),
  };
}

export function buildPersonIdentityLookup(
  records: PersonIdentityRecord[],
): Map<string, PersonIdentityReference> {
  const lookup = new Map<string, PersonIdentityReference>();

  for (const record of [...records].sort((a, b) =>
    a.userId.localeCompare(b.userId),
  )) {
    if (record.deletedAt) continue;
    const reference = {
      slug: personIdentitySlug(record.userId),
      title: personIdentityDisplayName(record),
      effectiveDate: record.createdAt,
    };

    // Email is an internal linking hint for meeting attendees, not Brain page
    // content. It never leaves this process through the person-card projection.
    for (const alias of [...personIdentityAliases(record), record.email]) {
      const normalized = normalizeIdentityAlias(alias);
      if (normalized && !lookup.has(normalized)) {
        lookup.set(normalized, reference);
      }
    }
  }

  return lookup;
}

function latestIdentityUpdate(record: PersonIdentityRecord): Date {
  return record.providers.reduce(
    (latest, provider) =>
      provider.updatedAt > latest ? provider.updatedAt : latest,
    record.deletedAt && record.deletedAt > record.updatedAt
      ? record.deletedAt
      : record.updatedAt,
  );
}

async function loadPersonIdentityRecords(): Promise<PersonIdentityRecord[]> {
  const [
    memberRows,
    slackRows,
    githubRows,
    sourceControlRows,
    telegramRows,
    discordRows,
    teamsRows,
    slackDirectoryRows,
  ] = await Promise.all([
    db.select().from(users),
    db.select().from(slackUserMappings),
    db.select().from(githubUserMappings),
    db.select().from(sourceControlUserMappings),
    db.select().from(telegramUserMappings),
    db.select().from(discordUserMappings),
    db.select().from(teamsUserMappings),
    db.select().from(slackDirectoryUsers),
  ]);
  const byUserId = new Map<string, PersonIdentityRecord>(
    memberRows
      .filter((member) => member.id !== LEGACY_SETUP_BOOTSTRAP_USER_ID)
      .map((member) => [
        member.id,
        {
          userId: member.id,
          name: member.name,
          email: member.email,
          role: member.role,
          createdAt: member.createdAt,
          updatedAt: member.updatedAt,
          deletedAt: member.deletedAt,
          providers: [],
        },
      ]),
  );
  const addProvider = (userId: string, provider: PersonIdentityProvider) => {
    byUserId.get(userId)?.providers.push(provider);
  };
  const slackDirectoryByIdentity = new Map(
    slackDirectoryRows.map((profile) => [
      `${profile.slackTeamId}/${profile.slackUserId}`,
      profile,
    ]),
  );

  for (const row of slackRows) {
    const cachedProfile = slackDirectoryByIdentity.get(
      `${row.slackTeamId}/${row.slackUserId}`,
    );
    const profile =
      cachedProfile &&
      !cachedProfile.isBot &&
      !cachedProfile.isAppUser &&
      cachedProfile.slackUserId !== 'USLACKBOT'
        ? cachedProfile
        : undefined;
    addProvider(row.userId, {
      provider: 'Slack',
      identifier: row.slackUserId,
      display:
        profile?.displayName ??
        profile?.realName ??
        profile?.username ??
        byUserId.get(row.userId)?.name,
      title: profile?.title,
      updatedAt:
        profile?.profileUpdatedAt && profile.profileUpdatedAt > row.updatedAt
          ? profile.profileUpdatedAt
          : row.updatedAt,
    });
  }
  for (const row of githubRows) {
    addProvider(row.userId, {
      provider: 'GitHub',
      identifier: row.githubLogin,
      updatedAt: row.updatedAt,
    });
  }
  for (const row of sourceControlRows) {
    addProvider(row.userId, {
      provider: row.sourceControlProvider,
      identifier: row.username ?? row.externalAccountId,
      display: row.displayName,
      updatedAt: row.updatedAt,
    });
  }
  for (const row of telegramRows) {
    addProvider(row.userId, {
      provider: 'Telegram',
      identifier: row.telegramUsername ?? row.telegramUserId,
      updatedAt: row.updatedAt,
    });
  }
  for (const row of discordRows) {
    addProvider(row.userId, {
      provider: 'Discord',
      identifier: row.discordUsername ?? row.discordUserId,
      display: row.discordGlobalName,
      updatedAt: row.updatedAt,
    });
  }
  for (const row of teamsRows) {
    addProvider(row.userId, {
      provider: 'Microsoft Teams',
      identifier: row.teamsAadObjectId ?? row.teamsUserId,
      updatedAt: row.updatedAt,
    });
  }

  return [...byUserId.values()];
}

const SLACK_DIRECTORY_COLLECTOR_ID =
  'slack-person-directory:occurrence-date-v2';
const SLACK_DIRECTORY_REFRESH_MS = 24 * 60 * 60 * 1000;
const SLACK_DIRECTORY_PAGE_SIZE = 100;

export function isSlackDirectoryRefreshDue(input: {
  state: { watermark: Date | null; backfillCursor: string | null } | null;
  now: Date;
}): boolean {
  const { state, now } = input;

  return (
    !state ||
    Boolean(state.backfillCursor) ||
    !state.watermark ||
    now.getTime() - state.watermark.getTime() >= SLACK_DIRECTORY_REFRESH_MS
  );
}

export type SlackDirectoryProfile = {
  slackUserId: string;
  slackTeamId: string;
  slackTeamName: string;
  username: string | null;
  displayName: string | null;
  realName: string | null;
  title: string | null;
  isDeleted: boolean;
  isBot: boolean;
  isAppUser: boolean;
  profileUpdatedAt: Date | null;
  firstKnownAt: Date;
};

type RawSlackDirectoryUser = {
  id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  updated?: number;
  profile?: {
    display_name?: string;
    real_name?: string;
    title?: string;
  };
};

export function slackDirectoryPageUserIds(
  users: Array<{ id?: string }>,
): string[] {
  return [
    ...new Set(
      users
        .map((user) => user.id?.trim())
        .filter((id): id is string => Boolean(id)),
    ),
  ];
}

function slackDirectoryIdentityKey(teamId: string, userId: string): string {
  return `${teamId}/${userId}`;
}

function slackDirectoryPersonSlug(teamId: string, userId: string): string {
  const digest = createHash('sha256')
    .update(`slack:${teamId}:${userId}`)
    .digest('hex')
    .slice(0, 16);
  return `people/slack-member-${digest}`;
}

export function slackDirectoryProfileFromApi(input: {
  teamId: string;
  teamName: string;
  user: RawSlackDirectoryUser;
  firstKnownAt?: Date;
  observedAt?: Date;
}): SlackDirectoryProfile | null {
  const slackUserId = input.user.id?.trim();
  if (!slackUserId) return null;

  const toOptional = (value: string | undefined) => value?.trim() || null;
  const updatedSeconds = input.user.updated;

  const profileUpdatedAt =
    typeof updatedSeconds === 'number' && Number.isFinite(updatedSeconds)
      ? new Date(updatedSeconds * 1000)
      : null;
  const firstKnownAt = [input.firstKnownAt, profileUpdatedAt, input.observedAt]
    .filter((date): date is Date => Boolean(date))
    .sort((a, b) => a.getTime() - b.getTime())[0];

  if (!firstKnownAt) return null;

  return {
    slackUserId,
    slackTeamId: input.teamId,
    slackTeamName: input.teamName,
    username: toOptional(input.user.name),
    displayName: toOptional(input.user.profile?.display_name),
    realName: toOptional(input.user.profile?.real_name ?? input.user.real_name),
    title: toOptional(input.user.profile?.title),
    isDeleted: input.user.deleted === true,
    isBot: input.user.is_bot === true,
    isAppUser: input.user.is_app_user === true,
    profileUpdatedAt,
    firstKnownAt,
  };
}

export function isSlackHumanProfile(
  profile: SlackDirectoryProfile,
  botUserId: string,
): boolean {
  return (
    !profile.isBot &&
    !profile.isAppUser &&
    profile.slackUserId !== botUserId &&
    profile.slackUserId !== 'USLACKBOT'
  );
}

function slackDirectoryDisplayName(profile: SlackDirectoryProfile): string {
  return (
    brainSafeIdentityValue(profile.displayName ?? '') ||
    brainSafeIdentityValue(profile.realName ?? '') ||
    brainSafeIdentityValue(profile.username ?? '') ||
    'Slack member'
  );
}

export function buildSlackDirectoryPersonPage(
  profile: SlackDirectoryProfile,
  canonical?: PersonIdentityReference,
): CollectorPage {
  const slug = slackDirectoryPersonSlug(
    profile.slackTeamId,
    profile.slackUserId,
  );
  const name = slackDirectoryDisplayName(profile);
  const safeWorkspace =
    brainSafeIdentityValue(profile.slackTeamName) || 'Slack workspace';
  const effectiveDate = canonical?.effectiveDate
    ? new Date(
        Math.min(
          canonical.effectiveDate.getTime(),
          profile.firstKnownAt.getTime(),
        ),
      )
    : profile.firstKnownAt;

  if (canonical) {
    return {
      slug,
      title: name,
      content: [
        '---',
        'type: person-alias',
        `canonical: ${JSON.stringify(canonical.slug)}`,
        `event_date: ${formatUtcDay(effectiveDate)}`,
        'provenance: slack-directory',
        '---',
        '',
        `# ${name}`,
        '',
        `This Slack identity belongs to [${canonical.title}](${canonical.slug}).`,
        '',
      ].join('\n'),
    };
  }

  const aliases = profile.isDeleted
    ? []
    : [profile.displayName, profile.realName, profile.username]
        .map((value) => brainSafeIdentityValue(value ?? ''))
        .filter(
          (value, index, values) => value && values.indexOf(value) === index,
        )
        .sort((a, b) => a.localeCompare(b));
  const safeTitle = brainSafeIdentityValue(profile.title ?? '');

  return {
    slug,
    title: name,
    content: [
      '---',
      'type: person',
      `aliases: ${JSON.stringify(aliases)}`,
      `status: ${profile.isDeleted ? 'deleted' : 'active'}`,
      `event_date: ${formatUtcDay(effectiveDate)}`,
      ...(safeTitle ? [`job_title: ${JSON.stringify(safeTitle)}`] : []),
      'provenance: slack-directory',
      `workspace: ${JSON.stringify(safeWorkspace)}`,
      '---',
      '',
      `# ${name}`,
      '',
      profile.isDeleted
        ? `Former member of the ${safeWorkspace} Slack workspace.`
        : `Member of the ${safeWorkspace} Slack workspace.`,
      ...(safeTitle ? ['', `Title: ${safeTitle}`] : []),
      '',
      '## Linked identities',
      '',
      `- Slack: ${profile.username ? `${brainSafeIdentityValue(profile.username)} (${profile.slackUserId})` : profile.slackUserId}`,
      '',
    ].join('\n'),
  };
}

async function loadSlackCanonicalIdentityLookup(): Promise<
  Map<string, PersonIdentityReference>
> {
  const mappings = await db.query.slackUserMappings.findMany({
    with: {
      user: { columns: { name: true, deletedAt: true, createdAt: true } },
    },
  });
  const lookup = new Map<string, PersonIdentityReference>();

  for (const mapping of mappings) {
    if (
      mapping.userId === LEGACY_SETUP_BOOTSTRAP_USER_ID ||
      mapping.user.deletedAt
    ) {
      continue;
    }
    lookup.set(
      slackDirectoryIdentityKey(mapping.slackTeamId, mapping.slackUserId),
      {
        slug: personIdentitySlug(mapping.userId),
        title: brainSafeIdentityValue(mapping.user.name) || 'Roomote member',
        effectiveDate: mapping.user.createdAt,
      },
    );
  }

  return lookup;
}

async function persistSlackDirectoryProfiles(
  profiles: SlackDirectoryProfile[],
  now: Date,
): Promise<void> {
  for (const profile of profiles) {
    await db
      .insert(slackDirectoryUsers)
      .values({
        slackUserId: profile.slackUserId,
        slackTeamId: profile.slackTeamId,
        username: profile.username,
        displayName: profile.displayName,
        realName: profile.realName,
        title: profile.title,
        isDeleted: profile.isDeleted,
        isBot: profile.isBot,
        isAppUser: profile.isAppUser,
        profileUpdatedAt: profile.profileUpdatedAt,
        lastSeenAt: now,
        updatedAt: profile.profileUpdatedAt ?? now,
      })
      .onConflictDoUpdate({
        target: [
          slackDirectoryUsers.slackUserId,
          slackDirectoryUsers.slackTeamId,
        ],
        set: {
          username: profile.username,
          displayName: profile.displayName,
          realName: profile.realName,
          title: profile.title,
          isDeleted: profile.isDeleted,
          isBot: profile.isBot,
          isAppUser: profile.isAppUser,
          profileUpdatedAt: profile.profileUpdatedAt,
          lastSeenAt: now,
          updatedAt: profile.profileUpdatedAt ?? now,
        },
      });
  }
}

type SlackDirectoryBatch = {
  pages: CollectorPage[];
  nextSlackCursor: string | null;
};

async function readSlackDirectoryBatch(input: {
  installation: typeof slackInstallations.$inferSelect;
  slackCursor: string | null;
  limit: number;
  now: Date;
}): Promise<SlackDirectoryBatch> {
  const client = createSlackWebClient(input.installation.botAccessToken);
  const [canonical, response] = await Promise.all([
    loadSlackCanonicalIdentityLookup(),
    client.users.list({
      limit: Math.min(input.limit, SLACK_DIRECTORY_PAGE_SIZE),
      ...(input.slackCursor ? { cursor: input.slackCursor } : {}),
    }),
  ]);
  const listed = (response.members ?? []) as RawSlackDirectoryUser[];
  const pageUserIds = slackDirectoryPageUserIds(listed);

  // users.list supplies the directory and full profile shape. Refresh linked
  // Roomote identities with users.info so their canonical cards pick up the
  // freshest Slack name/title even if a paginated directory snapshot lags.
  const [existingProfiles, refreshed] = await Promise.all([
    pageUserIds.length > 0
      ? db.query.slackDirectoryUsers.findMany({
          where: and(
            eq(slackDirectoryUsers.slackTeamId, input.installation.teamId),
            inArray(slackDirectoryUsers.slackUserId, pageUserIds),
          ),
          columns: { slackUserId: true, createdAt: true },
        })
      : Promise.resolve([]),
    Promise.all(
      listed.map(async (user) => {
        if (
          !user.id ||
          !canonical.has(
            slackDirectoryIdentityKey(input.installation.teamId, user.id),
          )
        ) {
          return user;
        }
        try {
          const info = await client.users.info({ user: user.id });
          return (info.user as RawSlackDirectoryUser | undefined) ?? user;
        } catch (error) {
          console.warn(
            `${LOG_PREFIX} slack team ${input.installation.teamId}: users.info failed for a linked member; using users.list profile: ${error instanceof Error ? error.message : String(error)}`,
          );
          return user;
        }
      }),
    ),
  ]);
  const existingCreatedAt = new Map(
    existingProfiles.map((profile) => [profile.slackUserId, profile.createdAt]),
  );
  const profiles = refreshed
    .map((user) =>
      slackDirectoryProfileFromApi({
        teamId: input.installation.teamId,
        teamName: input.installation.teamName,
        user,
        firstKnownAt: user.id ? existingCreatedAt.get(user.id) : undefined,
        observedAt: input.installation.createdAt,
      }),
    )
    .filter((profile): profile is SlackDirectoryProfile => Boolean(profile));

  // Cache every directory row so a human account that later becomes a bot or
  // app user cannot continue enriching a canonical Roomote person card.
  await persistSlackDirectoryProfiles(profiles, input.now);

  const humanProfiles = profiles.filter((profile) =>
    isSlackHumanProfile(profile, input.installation.botUserId),
  );

  return {
    pages: humanProfiles.map((profile) =>
      buildSlackDirectoryPersonPage(
        profile,
        canonical.get(
          slackDirectoryIdentityKey(profile.slackTeamId, profile.slackUserId),
        ),
      ),
    ),
    nextSlackCursor: response.response_metadata?.next_cursor?.trim() || null,
  };
}

type SlackDirectoryBackfillCursor = {
  teamId: string;
  slackCursor: string | null;
};

function parseSlackDirectoryBackfillCursor(
  raw: string | null,
): SlackDirectoryBackfillCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SlackDirectoryBackfillCursor>;
    return typeof parsed.teamId === 'string'
      ? {
          teamId: parsed.teamId,
          slackCursor:
            typeof parsed.slackCursor === 'string' ? parsed.slackCursor : null,
        }
      : null;
  } catch {
    return null;
  }
}

const slackPersonDirectoryCollector: BrainCollector = {
  id: SLACK_DIRECTORY_COLLECTOR_ID,
  displayName: 'Slack person directory',
  async isEnabled() {
    const installation = await db.query.slackInstallations.findFirst({
      columns: { id: true },
      where: eq(slackInstallations.isActive, true),
    });
    return Boolean(installation);
  },
  async collect({ now, limit }) {
    const collectorState = await getBrainSyncState(
      db,
      SLACK_DIRECTORY_COLLECTOR_ID,
    );
    if (!collectorState?.backfillCompletedAt) {
      return { pages: [], nextSince: null };
    }

    const installations = await db
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.isActive, true));
    const pages: CollectorPage[] = [];
    const stateUpdates: CollectorStateUpdate[] = [];

    for (const installation of installations.sort((a, b) =>
      a.teamId.localeCompare(b.teamId),
    )) {
      const stateId = `${SLACK_DIRECTORY_COLLECTOR_ID}:${installation.teamId}`;
      const state = await getBrainSyncState(db, stateId);
      const lastCompletedAt =
        state?.watermark ?? collectorState.backfillCompletedAt;
      const cursor = state?.backfillCursor ?? null;

      if (!isSlackDirectoryRefreshDue({ state, now })) {
        continue;
      }
      const remaining = limit - pages.length;
      if (remaining <= 0) break;

      try {
        const batch = await readSlackDirectoryBatch({
          installation,
          slackCursor: cursor,
          limit: remaining,
          now,
        });
        pages.push(...batch.pages);
        stateUpdates.push({
          collectorId: stateId,
          watermark: batch.nextSlackCursor ? lastCompletedAt : now,
          cursor: batch.nextSlackCursor,
        });
      } catch (error) {
        console.warn(
          `${LOG_PREFIX} slack team ${installation.teamId}: person directory refresh failed; holding its cursor: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return { pages, nextSince: null, stateUpdates };
  },
  async backfill({ cursor, limit }) {
    const installations = (
      await db
        .select()
        .from(slackInstallations)
        .where(eq(slackInstallations.isActive, true))
    ).sort((a, b) => a.teamId.localeCompare(b.teamId));
    if (installations.length === 0) {
      return { pages: [], nextCursor: null, done: true };
    }

    const parsed = parseSlackDirectoryBackfillCursor(cursor);
    const index = parsed
      ? installations.findIndex(({ teamId }) => teamId === parsed.teamId)
      : 0;
    const installation = installations[index >= 0 ? index : 0];
    if (!installation) {
      return { pages: [], nextCursor: null, done: true };
    }

    try {
      const batch = await readSlackDirectoryBatch({
        installation,
        slackCursor:
          parsed?.teamId === installation.teamId ? parsed.slackCursor : null,
        limit,
        now: new Date(),
      });
      const nextInstallation = installations[(index >= 0 ? index : 0) + 1];
      const nextCursor = batch.nextSlackCursor
        ? JSON.stringify({
            teamId: installation.teamId,
            slackCursor: batch.nextSlackCursor,
          })
        : nextInstallation
          ? JSON.stringify({
              teamId: nextInstallation.teamId,
              slackCursor: null,
            })
          : null;

      return {
        pages: batch.pages,
        nextCursor,
        done: nextCursor === null,
      };
    } catch (error) {
      console.warn(
        `${LOG_PREFIX} slack team ${installation.teamId}: person directory backfill failed; holding its cursor: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { pages: [], nextCursor: cursor, done: false };
    }
  },
};

const PERSON_IDENTITIES_STATE_ID =
  'person-identities:members:occurrence-date-v2';
const PERSON_IDENTITIES_RECONCILIATION_MS = 24 * 60 * 60 * 1000;
const GRANOLA_MEETINGS_COLLECTOR_ID = 'granola-meetings';

type PersonIdentityCursor = {
  mode: 'idle' | 'sweep' | 'incremental';
  lastSweepAt: string | null;
  projectionHash: string | null;
  afterUserId?: string;
  afterUpdatedAt?: string;
};

function parsePersonIdentityCursor(raw: string | null): PersonIdentityCursor {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<PersonIdentityCursor>;
      if (
        parsed.mode === 'idle' ||
        parsed.mode === 'sweep' ||
        parsed.mode === 'incremental'
      ) {
        return {
          mode: parsed.mode,
          lastSweepAt:
            typeof parsed.lastSweepAt === 'string' ? parsed.lastSweepAt : null,
          projectionHash:
            typeof parsed.projectionHash === 'string'
              ? parsed.projectionHash
              : null,
          ...(typeof parsed.afterUserId === 'string'
            ? { afterUserId: parsed.afterUserId }
            : {}),
          ...(typeof parsed.afterUpdatedAt === 'string'
            ? { afterUpdatedAt: parsed.afterUpdatedAt }
            : {}),
        };
      }
    } catch {
      // Restart with a full idempotent sweep if the cursor is unreadable.
    }
  }

  return { mode: 'sweep', lastSweepAt: null, projectionHash: null };
}

function serializePersonIdentityCursor(cursor: PersonIdentityCursor): string {
  return JSON.stringify(cursor);
}

function personIdentityProjectionHash(records: PersonIdentityRecord[]): string {
  const projection = [...records]
    .sort((a, b) => a.userId.localeCompare(b.userId))
    .map((record) => ({
      userId: record.userId,
      name: record.name,
      email: record.email,
      role: record.role,
      deletedAt: record.deletedAt?.toISOString() ?? null,
      providers: [...record.providers]
        .sort(
          (a, b) =>
            a.provider.localeCompare(b.provider) ||
            a.identifier.localeCompare(b.identifier) ||
            (a.display ?? '').localeCompare(b.display ?? ''),
        )
        .map(({ provider, identifier, display, title }) => ({
          provider,
          identifier,
          display: display ?? null,
          title: title ?? null,
        })),
    }));

  return createHash('sha256').update(JSON.stringify(projection)).digest('hex');
}

export function selectPersonIdentityBatch(input: {
  records: PersonIdentityRecord[];
  state: { watermark: Date | null; cursor: string | null } | null;
  now: Date;
  limit: number;
}): {
  records: PersonIdentityRecord[];
  watermark: Date;
  cursor: string;
  projectionChanged: boolean;
} {
  const { records, state, now, limit } = input;
  const cursor = parsePersonIdentityCursor(state?.cursor ?? null);
  const projectionHash = personIdentityProjectionHash(records);
  const projectionChanged = cursor.projectionHash !== projectionHash;
  const lastSweepAt = cursor.lastSweepAt ? new Date(cursor.lastSweepAt) : null;
  const sweepDue =
    !lastSweepAt ||
    Number.isNaN(lastSweepAt.getTime()) ||
    now.getTime() - lastSweepAt.getTime() >=
      PERSON_IDENTITIES_RECONCILIATION_MS;

  if (cursor.mode === 'sweep' || sweepDue || projectionChanged) {
    const afterUserId =
      cursor.mode === 'sweep' && !projectionChanged ? cursor.afterUserId : '';
    const candidates = [...records]
      .sort((a, b) => a.userId.localeCompare(b.userId))
      .filter((record) => record.userId > (afterUserId ?? ''));
    const batch = candidates.slice(0, limit);
    const last = batch.at(-1);
    const hasMore = candidates.length > batch.length;

    return {
      records: batch,
      watermark: hasMore ? (state?.watermark ?? new Date(0)) : now,
      projectionChanged,
      cursor: serializePersonIdentityCursor(
        hasMore && last
          ? {
              mode: 'sweep',
              lastSweepAt: cursor.lastSweepAt,
              projectionHash,
              afterUserId: last.userId,
            }
          : {
              mode: 'idle',
              lastSweepAt: now.toISOString(),
              projectionHash,
            },
      ),
    };
  }

  const incrementalCursor = cursor.mode === 'incremental' ? cursor : null;
  const afterUpdatedAt = incrementalCursor?.afterUpdatedAt
    ? new Date(incrementalCursor.afterUpdatedAt)
    : (state?.watermark ?? new Date(0));
  const afterUserId = incrementalCursor?.afterUserId ?? '';
  const candidates = records
    .filter((record) => {
      const updatedAt = latestIdentityUpdate(record);
      return (
        updatedAt > afterUpdatedAt ||
        (incrementalCursor &&
          updatedAt.getTime() === afterUpdatedAt.getTime() &&
          record.userId > afterUserId)
      );
    })
    .sort(
      (a, b) =>
        latestIdentityUpdate(a).getTime() - latestIdentityUpdate(b).getTime() ||
        a.userId.localeCompare(b.userId),
    );
  const batch = candidates.slice(0, limit);
  const last = batch.at(-1);
  const hasMore = candidates.length > batch.length;

  return {
    records: batch,
    watermark: hasMore ? afterUpdatedAt : now,
    projectionChanged,
    cursor: serializePersonIdentityCursor(
      hasMore && last
        ? {
            mode: 'incremental',
            lastSweepAt: cursor.lastSweepAt,
            projectionHash,
            afterUpdatedAt: latestIdentityUpdate(last).toISOString(),
            afterUserId: last.userId,
          }
        : {
            mode: 'idle',
            lastSweepAt: cursor.lastSweepAt,
            projectionHash,
          },
    ),
  };
}

const personIdentitiesCollector: BrainCollector = {
  id: 'person-identities',
  displayName: 'Roomote member identities',
  async isEnabled() {
    return true;
  },
  async collect({ now, limit }) {
    const state = await getBrainSyncState(db, PERSON_IDENTITIES_STATE_ID);
    const batch = selectPersonIdentityBatch({
      records: await loadPersonIdentityRecords(),
      state: state
        ? {
            watermark: state.watermark,
            cursor: state.backfillCursor,
          }
        : null,
      now,
      limit,
    });

    return {
      pages: batch.records.map(buildPersonIdentityPage),
      nextSince: null,
      stateUpdates: [
        {
          collectorId: PERSON_IDENTITIES_STATE_ID,
          watermark: batch.watermark,
          cursor: batch.cursor,
        },
        ...(batch.projectionChanged
          ? [
              {
                collectorId: GRANOLA_MEETINGS_COLLECTOR_ID,
                cursor: null,
                backfillCompletedAt: null,
              },
            ]
          : []),
      ],
    };
  },
};

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

/**
 * Rippling: authoritative employee directory
 * -------------------------------------------
 *
 * Rippling's V2 workers endpoint is cursor paginated but Worker Changes is a
 * separately entitled API product. Use complete, resumable snapshots here so
 * every installation gets correct lifecycle handling without assuming that
 * optional entitlement. Reconciliation starts only after the final page.
 */

const RIPPLING_WORKERS_COLLECTOR_ID = 'rippling-workers';
const RIPPLING_SNAPSHOT_STATE_ID = `${RIPPLING_WORKERS_COLLECTOR_ID}:snapshot`;
const RIPPLING_WORKER_EXPANSIONS =
  'user,manager,manager.user,department,employment_type,teams';

type RipplingObject = Record<string, unknown>;

type RipplingWorker = RipplingObject & {
  id?: unknown;
  status?: unknown;
  work_email?: unknown;
  user?: unknown;
  manager_id?: unknown;
  manager?: unknown;
  title?: unknown;
  department_id?: unknown;
  department?: unknown;
  teams?: unknown;
  employment_type_id?: unknown;
  employment_type?: unknown;
  location?: unknown;
  start_date?: unknown;
  end_date?: unknown;
};

type RipplingWorkersResponse = {
  results?: unknown;
  next_link?: unknown;
};

type RipplingSnapshotCursor =
  | { mode: 'idle'; lastCompletedAt: string | null }
  | { mode: 'scan'; startedAt: string; nextLink: string | null }
  | { mode: 'reconcile'; startedAt: string };

function asObject(value: unknown): RipplingObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RipplingObject)
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const resolved = asString(value);
    if (resolved) return resolved;
  }
  return null;
}

function ripplingDisplayName(worker: RipplingWorker): string {
  const user = asObject(worker.user);
  const name = asObject(user?.name);
  const displayName = firstString(
    name?.display_name,
    name?.preferred_name,
    user?.display_name,
  );
  if (displayName) return brainSafeIdentityValue(displayName);

  const joined = [
    firstString(name?.given_name, user?.given_name),
    firstString(name?.family_name, user?.family_name),
  ]
    .filter(Boolean)
    .join(' ');
  return brainSafeIdentityValue(joined) || 'Rippling worker';
}

function ripplingWorkEmail(worker: RipplingWorker): string | null {
  return firstString(worker.work_email, asObject(worker.user)?.work_email);
}

function ripplingWorkerId(worker: RipplingWorker): string | null {
  return firstString(worker.id);
}

function ripplingWorkerSlug(workerId: string): string {
  const digest = createHash('sha256')
    .update(workerId)
    .digest('hex')
    .slice(0, 16);
  return `people/rippling-worker-${digest}`;
}

type RipplingMembership = {
  type: 'department' | 'team';
  id: string | null;
  name: string;
};

function ripplingNamedObject(
  value: unknown,
  fallbackId: unknown,
): { id: string | null; name: string } | null {
  const object = asObject(value);
  const id = firstString(object?.id, fallbackId);
  const name = firstString(object?.name, object?.label, object?.display_name);
  if (!name && !id) return null;
  return { id, name: brainSafeIdentityValue(name ?? id ?? '') };
}

function ripplingMemberships(worker: RipplingWorker): RipplingMembership[] {
  const memberships: RipplingMembership[] = [];
  const department = ripplingNamedObject(
    worker.department,
    worker.department_id,
  );
  if (department?.name) {
    memberships.push({ type: 'department', ...department });
  }

  if (Array.isArray(worker.teams)) {
    for (const teamValue of worker.teams) {
      const team = ripplingNamedObject(teamValue, null);
      if (team?.name) memberships.push({ type: 'team', ...team });
    }
  }

  return memberships.sort(
    (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name),
  );
}

function ripplingEmploymentType(worker: RipplingWorker): string | null {
  const employmentType = asObject(worker.employment_type);
  return firstString(
    employmentType?.label,
    employmentType?.name,
    employmentType?.type,
    worker.employment_type_id,
  );
}

function ripplingLocation(worker: RipplingWorker): string | null {
  const location = asObject(worker.location);
  if (!location) return firstString(worker.location);

  const type = firstString(location.type);
  const name = firstString(
    location.name,
    location.label,
    location.work_location_name,
    location.work_location_id,
  );
  return (
    [type, name]
      .filter(Boolean)
      .map((value) => brainSafeIdentityValue(value!))
      .join(' — ') || null
  );
}

export function parseRipplingWorkersResponse(payload: unknown): {
  workers: RipplingWorker[];
  nextLink: string | null;
} {
  const response = asObject(payload) as RipplingWorkersResponse | null;
  if (!response || !Array.isArray(response.results)) {
    throw new Error(
      'Rippling workers response did not contain a results array',
    );
  }

  const workers = response.results.map((worker, index) => {
    const object = asObject(worker) as RipplingWorker | null;
    if (!object || !ripplingWorkerId(object)) {
      throw new Error(
        `Rippling workers response contained an invalid worker at index ${index}`,
      );
    }
    return object;
  });

  return {
    workers,
    nextLink: firstString(response.next_link),
  };
}

export function parseRipplingSnapshotCursor(
  value: string | null,
): RipplingSnapshotCursor {
  if (!value) return { mode: 'idle', lastCompletedAt: null };
  try {
    const parsed = JSON.parse(value) as Partial<RipplingSnapshotCursor>;
    if (
      parsed.mode === 'scan' &&
      firstString(parsed.startedAt) &&
      (parsed.nextLink === null || typeof parsed.nextLink === 'string')
    ) {
      return {
        mode: 'scan',
        startedAt: parsed.startedAt!,
        nextLink: parsed.nextLink ?? null,
      };
    }
    if (parsed.mode === 'reconcile' && firstString(parsed.startedAt)) {
      return { mode: 'reconcile', startedAt: parsed.startedAt! };
    }
    if (
      parsed.mode === 'idle' &&
      (parsed.lastCompletedAt === null ||
        typeof parsed.lastCompletedAt === 'string')
    ) {
      return {
        mode: 'idle',
        lastCompletedAt: parsed.lastCompletedAt ?? null,
      };
    }
  } catch {
    // A malformed cursor safely restarts a complete snapshot.
  }
  return { mode: 'idle', lastCompletedAt: null };
}

function serializeRipplingSnapshotCursor(
  cursor: RipplingSnapshotCursor,
): string {
  return JSON.stringify(cursor);
}

type RipplingPersonReference = {
  slug: string;
  title: string;
};

function ripplingManagerReference(
  worker: RipplingWorker,
  identities: Map<string, PersonIdentityReference>,
): RipplingPersonReference | null {
  const manager = asObject(worker.manager) as RipplingWorker | null;
  const managerId = firstString(worker.manager_id, manager?.id);
  if (!managerId) return null;

  const managerEmail = manager ? ripplingWorkEmail(manager) : null;
  const canonical = managerEmail
    ? identities.get(normalizeIdentityAlias(managerEmail))
    : null;
  return canonical
    ? { slug: canonical.slug, title: canonical.title }
    : {
        slug: ripplingWorkerSlug(managerId),
        title: manager ? ripplingDisplayName(manager) : 'Manager',
      };
}

export function buildRipplingWorkerPage(input: {
  worker: RipplingWorker;
  observedAt: Date;
  snapshotStartedAt: Date;
  identities?: Map<string, PersonIdentityReference>;
}): CollectorPage | null {
  const workerId = ripplingWorkerId(input.worker);
  if (!workerId) return null;

  const identities = input.identities ?? new Map();
  const name = ripplingDisplayName(input.worker);
  const workEmail = ripplingWorkEmail(input.worker);
  const canonical = workEmail
    ? identities.get(normalizeIdentityAlias(workEmail))
    : null;
  const manager = ripplingManagerReference(input.worker, identities);
  const managerId = firstString(
    input.worker.manager_id,
    asObject(input.worker.manager)?.id,
  );
  const memberships = ripplingMemberships(input.worker);
  const exactStatus = firstString(input.worker.status) ?? 'UNKNOWN';
  const active = exactStatus === 'ACTIVE';
  const title = firstString(input.worker.title);
  const employmentType = ripplingEmploymentType(input.worker);
  const location = ripplingLocation(input.worker);
  const timezone = firstString(asObject(input.worker.user)?.timezone);
  const startDate = firstString(input.worker.start_date);
  const endDate = firstString(input.worker.end_date);
  const employeeNumber = firstString(asObject(input.worker.user)?.number);
  const aliases = [name, workEmail, workerId].filter(Boolean);

  return {
    slug: ripplingWorkerSlug(workerId),
    title: name,
    content: [
      '---',
      `type: ${canonical ? 'person-alias' : 'person'}`,
      `aliases: ${JSON.stringify(active ? aliases : [])}`,
      `status: ${active ? 'active' : 'inactive'}`,
      `source_status: ${JSON.stringify(exactStatus)}`,
      `rippling_worker_id: ${JSON.stringify(workerId)}`,
      ...(employeeNumber
        ? [`employee_number: ${JSON.stringify(employeeNumber)}`]
        : []),
      ...(managerId
        ? [`rippling_manager_id: ${JSON.stringify(managerId)}`]
        : []),
      `source_authority: authoritative-hris`,
      `provenance: rippling-hris`,
      `observed_at: ${input.observedAt.toISOString()}`,
      `snapshot_started_at: ${input.snapshotStartedAt.toISOString()}`,
      ...(canonical ? [`canonical: ${JSON.stringify(canonical.slug)}`] : []),
      ...(workEmail ? [`work_email: ${JSON.stringify(workEmail)}`] : []),
      ...(title ? [`job_title: ${JSON.stringify(title)}`] : []),
      ...(employmentType
        ? [`employment_type: ${JSON.stringify(employmentType)}`]
        : []),
      ...(location ? [`location: ${JSON.stringify(location)}`] : []),
      ...(timezone ? [`timezone: ${JSON.stringify(timezone)}`] : []),
      ...(startDate ? [`start_date: ${JSON.stringify(startDate)}`] : []),
      ...(endDate ? [`end_date: ${JSON.stringify(endDate)}`] : []),
      ...(manager ? [`reports_to: ${JSON.stringify(manager.slug)}`] : []),
      `authoritative_memberships: ${JSON.stringify(memberships)}`,
      '---',
      '',
      `# ${name}`,
      '',
      ...(canonical
        ? [`Rippling identity for [${canonical.title}](${canonical.slug}).`, '']
        : []),
      '## Employment',
      '',
      `- Rippling employee ID: ${workerId}`,
      ...(employeeNumber ? [`- Employee number: ${employeeNumber}`] : []),
      `- Status: ${exactStatus}`,
      ...(workEmail ? [`- Work email: ${workEmail}`] : []),
      ...(title ? [`- Title: ${brainSafeIdentityValue(title)}`] : []),
      ...(employmentType
        ? [`- Employment type: ${brainSafeIdentityValue(employmentType)}`]
        : []),
      ...(location ? [`- Location: ${brainSafeIdentityValue(location)}`] : []),
      ...(timezone ? [`- Time zone: ${brainSafeIdentityValue(timezone)}`] : []),
      ...(startDate ? [`- Start date: ${startDate}`] : []),
      ...(endDate ? [`- End date: ${endDate}`] : []),
      '',
      '## Authoritative organization data',
      '',
      ...(manager
        ? [`- Reports to: [${manager.title}](${manager.slug})`]
        : ['- Reports to: not provided']),
      ...(memberships.length > 0
        ? memberships.map(
            (membership) =>
              `- ${membership.type === 'department' ? 'Department' : 'Team'}: ${membership.name}`,
          )
        : ['- Memberships: none provided']),
      '',
      '_Reporting and membership fields above come directly from Rippling HRIS. Collaboration-derived relationships elsewhere in Brain are inferred signals, not replacements for this source._',
      '',
    ].join('\n'),
  };
}

export function buildUnavailableRipplingWorkerPage(item: {
  itemId: string;
  slug: string;
}): CollectorPage {
  return {
    slug: item.slug,
    title: 'Unavailable Rippling worker',
    content: [
      '---',
      'type: person',
      'aliases: []',
      'status: unavailable',
      `rippling_worker_id: ${JSON.stringify(item.itemId)}`,
      'source_authority: authoritative-hris',
      'provenance: rippling-hris',
      '---',
      '',
      '# Unavailable Rippling worker',
      '',
      'This worker was absent from the latest complete Rippling roster snapshot or the integration was disconnected.',
      '',
    ].join('\n'),
  };
}

async function findRipplingConnectionConfig(): Promise<McpConnectionRipplingConfig | null> {
  const [connection, enablement] = await Promise.all([
    db.query.mcpConnections.findFirst({
      where: and(
        eq(mcpConnections.mcpId, 'rippling'),
        isNull(mcpConnections.userId),
        eq(mcpConnections.enabled, true),
        eq(mcpConnections.authStatus, 'authenticated'),
      ),
    }),
    db.query.deploymentMcpEnablements.findFirst({
      where: and(
        eq(deploymentMcpEnablements.mcpId, 'rippling'),
        eq(deploymentMcpEnablements.enabled, true),
      ),
      columns: { mcpId: true },
    }),
  ]);

  return enablement && isMcpConnectionRipplingConfig(connection?.authConfig)
    ? connection.authConfig
    : null;
}

async function collectRipplingReconciliation(
  startedAt: Date,
  limit: number,
): Promise<CollectorResult> {
  const stale = await listBrainCollectorItemsBefore(
    db,
    RIPPLING_WORKERS_COLLECTOR_ID,
    startedAt,
    limit + 1,
  );
  const batch = stale.slice(0, limit);
  const complete = stale.length <= limit;

  return {
    pages: batch.map(buildUnavailableRipplingWorkerPage),
    nextSince: complete ? startedAt : null,
    itemDeletes: [
      {
        collectorId: RIPPLING_WORKERS_COLLECTOR_ID,
        itemIds: batch.map((item) => item.itemId),
      },
    ],
    stateUpdates: [
      {
        collectorId: RIPPLING_SNAPSHOT_STATE_ID,
        cursor: serializeRipplingSnapshotCursor(
          complete
            ? { mode: 'idle', lastCompletedAt: startedAt.toISOString() }
            : { mode: 'reconcile', startedAt: startedAt.toISOString() },
        ),
      },
    ],
  };
}

export function buildRipplingWorkersRequest(
  nextLink: string | null,
  limit: number,
): {
  pathOrUrl: string;
  query: { expand: string; limit?: number };
} {
  return {
    pathOrUrl: nextLink ?? 'workers/',
    query: {
      expand: RIPPLING_WORKER_EXPANSIONS,
      ...(nextLink ? {} : { limit: Math.min(100, Math.max(1, limit)) }),
    },
  };
}

async function collectRipplingWorkers(input: {
  config: McpConnectionRipplingConfig;
  now: Date;
  limit: number;
}): Promise<CollectorResult> {
  const state = await getBrainSyncState(db, RIPPLING_SNAPSHOT_STATE_ID);
  const saved = parseRipplingSnapshotCursor(state?.backfillCursor ?? null);
  if (saved.mode === 'reconcile') {
    return collectRipplingReconciliation(
      parseDate(saved.startedAt) ?? input.now,
      input.limit,
    );
  }

  const startedAt =
    saved.mode === 'scan'
      ? (parseDate(saved.startedAt) ?? input.now)
      : input.now;
  const request = buildRipplingWorkersRequest(
    saved.mode === 'scan' ? saved.nextLink : null,
    input.limit,
  );
  const response = await ripplingApiRequestJson<unknown>({
    config: input.config,
    ...request,
  });
  const batch = parseRipplingWorkersResponse(response);
  const identities = buildPersonIdentityLookup(
    await loadPersonIdentityRecords(),
  );
  const pages: CollectorPage[] = [];
  const itemUpdates: CollectorItemUpdate[] = [];

  for (const worker of batch.workers) {
    const page = buildRipplingWorkerPage({
      worker,
      identities,
      observedAt: input.now,
      snapshotStartedAt: startedAt,
    });
    const workerId = ripplingWorkerId(worker);
    if (!page || !workerId) {
      throw new Error('Rippling worker could not be projected safely');
    }
    pages.push(page);
    itemUpdates.push({
      collectorId: RIPPLING_WORKERS_COLLECTOR_ID,
      itemId: workerId,
      slug: page.slug,
      lastSeenAt: startedAt,
    });
  }

  return {
    pages,
    nextSince: null,
    itemUpdates,
    stateUpdates: [
      {
        collectorId: RIPPLING_SNAPSHOT_STATE_ID,
        cursor: serializeRipplingSnapshotCursor(
          batch.nextLink
            ? {
                mode: 'scan',
                startedAt: startedAt.toISOString(),
                nextLink: batch.nextLink,
              }
            : { mode: 'reconcile', startedAt: startedAt.toISOString() },
        ),
      },
    ],
  };
}

async function collectDisabledRipplingWorkers(
  limit: number,
): Promise<CollectorResult> {
  const tracked = await listBrainCollectorItems(
    db,
    RIPPLING_WORKERS_COLLECTOR_ID,
    limit + 1,
  );
  const batch = tracked.slice(0, limit);
  return {
    pages: batch.map(buildUnavailableRipplingWorkerPage),
    nextSince: null,
    itemDeletes: [
      {
        collectorId: RIPPLING_WORKERS_COLLECTOR_ID,
        itemIds: batch.map((item) => item.itemId),
      },
    ],
    ...(tracked.length <= limit
      ? {
          stateUpdates: [
            {
              collectorId: RIPPLING_SNAPSHOT_STATE_ID,
              cursor: serializeRipplingSnapshotCursor({
                mode: 'idle',
                lastCompletedAt: null,
              }),
            },
          ],
        }
      : {}),
  };
}

const ripplingWorkersCollector: BrainCollector = {
  id: RIPPLING_WORKERS_COLLECTOR_ID,
  displayName: 'Rippling employee directory',
  async isEnabled() {
    const [config, tracked] = await Promise.all([
      findRipplingConnectionConfig(),
      listBrainCollectorItems(db, RIPPLING_WORKERS_COLLECTOR_ID, 1),
    ]);
    return Boolean(config || tracked.length > 0);
  },
  async collect({ now, limit }) {
    const config = await findRipplingConnectionConfig();
    return config
      ? collectRipplingWorkers({ config, now, limit })
      : collectDisabledRipplingWorkers(limit);
  },
};

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

const notionPagesCollector: BrainCollector = {
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

type GranolaAttendee = { display: string; identityCandidates: string[] };

function extractAttendees(note: Record<string, unknown>): GranolaAttendee[] {
  const raw = note.attendees ?? note.people ?? note.participants;

  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((entry) => {
      if (typeof entry === 'string') {
        const value = entry.trim();
        return value ? { display: value, identityCandidates: [value] } : null;
      }

      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        const name = asString(record.name);
        const email = asString(record.email);
        const identityCandidates = [name, email].filter(
          (value): value is string => Boolean(value),
        );

        return identityCandidates.length > 0
          ? {
              display: name ?? email!,
              identityCandidates,
            }
          : null;
      }

      return null;
    })
    .filter((attendee): attendee is GranolaAttendee => Boolean(attendee));
}

const GRANOLA_NOTE_EXCERPT_MAX_CHARS = 3000;

/**
 * Map one Granola note object to a memory page. Defensive by design: the
 * exact response shape is not contract-pinned, so unknown shapes produce
 * `null` (zero pages) instead of throwing. Pure function, exported for tests.
 */
export function buildGranolaMeetingPage(
  note: unknown,
  identities: ReadonlyMap<string, PersonIdentityReference> = new Map(),
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
  const titleSlug = slugifySegment(title) || 'meeting';
  const idSlug = id ? slugifySegment(id) : null;
  const slugTail = idSlug ? `${titleSlug}-${idSlug}` : titleSlug;
  const attendees = extractAttendees(record);
  const resolvedAttendees = attendees.map((attendee) => ({
    display: attendee.display,
    identity: attendee.identityCandidates
      .map((candidate) => identities.get(normalizeIdentityAlias(candidate)))
      .find(Boolean),
  }));
  const attendeeSlugs = [
    ...new Set(
      resolvedAttendees
        .map(({ identity }) => identity?.slug)
        .filter((slug): slug is string => Boolean(slug)),
    ),
  ];
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
    ...(attendeeSlugs.length > 0
      ? [`attendees: ${JSON.stringify(attendeeSlugs)}`]
      : []),
    '---',
    '',
    `# ${title}`,
    '',
    `Meeting on ${day}.`,
    ...(resolvedAttendees.length > 0
      ? [
          '',
          '## Attendees',
          '',
          ...resolvedAttendees.map(({ display, identity }) =>
            identity
              ? `- [${identity.title}](${identity.slug})`
              : `- ${display}`,
          ),
        ]
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
  const identities = buildPersonIdentityLookup(
    await loadPersonIdentityRecords(),
  );

  for (const note of notes.slice(0, GRANOLA_MAX_NOTES_PER_TICK)) {
    const mapped = buildGranolaMeetingPage(note, identities);

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
  const identities = buildPersonIdentityLookup(
    await loadPersonIdentityRecords(),
  );

  for (const note of payload.notes) {
    const mapped = buildGranolaMeetingPage(note, identities);

    if (mapped) {
      pages.push(mapped.page);
    }
  }

  const nextCursor = payload.hasMore && payload.cursor ? payload.cursor : null;

  return { pages, nextCursor, done: !nextCursor };
}

const granolaMeetingsCollector: BrainCollector = {
  id: GRANOLA_MEETINGS_COLLECTOR_ID,
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
  // Version when date semantics change so the deep backfill rewrites history.
  id: 'github-issues:occurrence-date-v3',
  displayName: 'GitHub issues',
  async isEnabled() {
    return hasBrainGithubSources();
  },
  async collect({ now, limit }) {
    return collectBrainGithubIssues({ now, limit });
  },
  async backfill({ cursor }) {
    return backfillBrainGithubIssuesStep({ cursor });
  },
};

const BRAIN_COLLECTORS: BrainCollector[] = [
  slackPersonDirectoryCollector,
  personIdentitiesCollector,
  ripplingWorkersCollector,
  slackPublicChannelsCollector,
  notionPagesCollector,
  granolaMeetingsCollector,
  githubIssuesCollector,
];
