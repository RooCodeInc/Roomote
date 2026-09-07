import {
  BRAIN_COLLECTOR_IDS,
  BRAIN_PAGE_TYPES,
  brainNamespacePrefix,
  renderBrainFrontmatter,
} from '@roomote/types';
import {
  db,
  eq,
  getBrainSyncState,
  slackInstallations,
} from '@roomote/db/server';
import { createSlackWebClient } from '@roomote/slack';
import { isBrainSourceAvailable } from '@roomote/sdk/server';

import type {
  BrainCollector,
  CollectorItemUpdate,
  CollectorPage,
  CollectorPageRetirement,
  CollectorResult,
  CollectorStateUpdate,
} from './contracts';
import {
  brainSafeIdentityValue,
  personIdentitySlug,
  type PersonIdentityReference,
} from './identity';
import {
  isSlackDayPageCensusComplete,
  reconcileSlackDayPages,
} from './slack-day-page-inventory';

const LOG_PREFIX = '[brainCollectors]';

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
  person?: PersonIdentityReference;
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
        const lines = chunk.map((message) => {
          const author =
            message.person && message.userId
              ? `[${message.person.title}](${message.person.slug}) (${message.userId})`
              : `<${
                  message.userLabel && message.userId
                    ? `${message.userLabel} (${message.userId})`
                    : (message.userId ?? 'unknown')
                }>`;
          return `- [${formatUtcTime(message.at)}] ${author}: ${message.text.trim()}`;
        });
        const firstTs = chunk[0]!.ts.replace('.', '-');
        const lastTs = chunk.at(-1)!.ts.replace('.', '-');
        // Lowercased to gbrain's canonical form: put_page lowercases slugs
        // before the row is written, so tracking the raw mixed-case string
        // would inventory pages under names the corpus never stores — and
        // retirement would never find them. (Slack team/channel ids are
        // uppercase.) Timeline `source` keys below stay as-is: they are
        // dedupe keys, not slugs, and changing their case would duplicate
        // append-only timeline rows.
        const slug =
          `${brainNamespacePrefix('slack')}${group.teamId}/${group.channelId}/${group.day}/${firstTs}-${lastTs}`.toLowerCase();
        const people = new Set<string>();
        for (const message of chunk) {
          if (!message.person) continue;
          people.add(message.person.slug);
        }

        pages.push({
          slug,
          title: `#${group.channelName} — ${group.day}`,
          content: [
            ...renderBrainFrontmatter({
              type: BRAIN_PAGE_TYPES.slackDay,
              title: `#${group.channelName} — ${group.day}`,
              created: group.day,
              fields: [`date: ${group.day}`],
            }),
            '',
            // put_page has no title parameter: gbrain derives a page's title
            // from the first markdown heading, and without one it falls back
            // to the slug tail — a raw timestamp range on these pages. Every
            // sibling collector leads with its title as a heading.
            `# #${group.channelName} — ${group.day}`,
            '',
            `Slack public channel #${group.channelName} (${group.channelId}), messages on ${group.day} (times UTC).`,
            '',
            ...lines,
          ].join('\n'),
          // Timeline rows are append-only. Keep their identity and payload
          // stable across collector windows, edits, channel renames, and
          // historical reprojections so one person's day cannot accumulate a
          // wall of stale per-batch activity atoms.
          timelineEvidence: [...people].map((personSlug) => ({
            slug: personSlug,
            date: group.day,
            summary: 'Participated in a public Slack channel',
            source: `slack:channel-day:${group.teamId}/${group.channelId}/${group.day}`,
          })),
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
  userLabels: ReadonlyMap<string, PersonIdentityReference> = new Map(),
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
        ? userLabels.get(`${channel.teamId}/${message.user}`)?.title
        : undefined,
      person: message.user
        ? userLabels.get(`${channel.teamId}/${message.user}`)
        : undefined,
      text: message.text,
    });
  }

  return collected;
}

async function loadSlackAuthorLabels(): Promise<
  Map<string, PersonIdentityReference>
> {
  try {
    const mappings = await db.query.slackUserMappings.findMany({
      with: {
        user: {
          columns: {
            id: true,
            name: true,
            createdAt: true,
            deletedAt: true,
          },
        },
      },
    });

    return new Map(
      mappings.flatMap(({ slackTeamId, slackUserId, user }) => {
        const title = brainSafeIdentityValue(user.name);
        return !user.deletedAt && title
          ? [
              [
                `${slackTeamId}/${slackUserId}`,
                {
                  slug: personIdentitySlug(user.id),
                  title,
                  effectiveDate: user.createdAt,
                },
              ] as const,
            ]
          : [];
      }),
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
  if (!(await isSlackDayPageCensusComplete())) {
    // Emitting a day before its legacy slugs are in the inventory would let
    // those pages dodge retirement forever, because nothing revisits a day
    // once its watermark passes. Watermarks have not started, so holding
    // costs ticks, never messages.
    return { pages: [], nextSince: null };
  }

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

  const stateUpdates: CollectorStateUpdate[] = [];
  // A completed deep backfill stays honest only while it covers every channel
  // the bot is in. Membership is re-discovered every pass, so a channel the
  // finished walk never read (the bot was added after completion) re-arms the
  // backfill; the preserved completed-set cursor makes the resumed walk read
  // just that channel's history.
  const backfillState = await getBrainSyncState(
    db,
    slackPublicChannelsCollector.id,
  );

  if (backfillState?.backfillCompletedAt) {
    const cursor = parseSlackBackfillCursor(
      backfillState.backfillCursor ?? null,
    );
    const backfilled = new Set(cursor?.completed ?? []);

    if (entries.some((entry) => !backfilled.has(entry.key))) {
      stateUpdates.push({
        collectorId: slackPublicChannelsCollector.id,
        backfillCompletedAt: null,
      });
    }
  }

  // Oldest partitions go first so a continuously busy channel cannot starve
  // another channel when the shared per-pass page budget is exhausted.
  entriesWithState.sort(
    (a, b) =>
      (a.state?.watermark?.getTime() ?? 0) -
        (b.state?.watermark?.getTime() ?? 0) || a.key.localeCompare(b.key),
  );

  const pages: CollectorPage[] = [];
  const itemUpdates: CollectorItemUpdate[] = [];
  const pageRetirements: CollectorPageRetirement[] = [];
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

    const reconciliation = await reconcileSlackDayPages({
      pages: channelPages,
      now: input.now,
    });
    itemUpdates.push(...reconciliation.itemUpdates);
    pageRetirements.push(...reconciliation.pageRetirements);

    if (complete) {
      stateUpdates.push({
        collectorId: entry.stateId,
        watermark: new Date(oldestMs + effectiveWindowMs),
      });
    }
  }

  return { pages, nextSince: null, stateUpdates, itemUpdates, pageRetirements };
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
  itemUpdates?: CollectorItemUpdate[];
  pageRetirements?: CollectorPageRetirement[];
}> {
  const noProgress = { pages: [], nextCursor: rawCursor, done: false };

  if (!(await isSlackDayPageCensusComplete())) {
    // Same hold as the incremental path: the deep backfill is the replay
    // that heals old pages, and it must not re-emit a day while that day's
    // legacy slugs are still invisible to retirement.
    return noProgress;
  }

  const userLabels = await loadSlackAuthorLabels();
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
    // Every known channel has been read: the deep backfill is genuinely
    // complete, and reporting it records that honestly (the settings page
    // reads backfillCompletedAt as "history read"). Completion is not
    // permanent: the incremental pass re-discovers membership every tick
    // and re-arms the backfill when a channel this walk never read appears,
    // and the engine preserves this cursor on completion so the resumed
    // walk reads only the new channel.
    return {
      pages: [],
      nextCursor: JSON.stringify({
        completed: [...completed].sort(),
        key: null,
        slackCursor: null,
        latest: null,
      }),
      done: true,
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
  // One Slack history page is a contiguous time slice of the channel, which
  // is exactly what the range-coverage retirement rule needs: a day chunk
  // spanning two cursor pages stays until a pass covers its whole range.
  const { itemUpdates, pageRetirements } = await reconcileSlackDayPages({
    pages,
    now: new Date(),
  });

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
      itemUpdates,
      pageRetirements,
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
    itemUpdates,
    pageRetirements,
  };
}

/** Exported for the fake-Slack integration test, which drives it directly. */
export const slackPublicChannelsCollector: BrainCollector = {
  // v3 is the healing replay the title-heading change (#1486) could not have:
  // back then a replay would have minted different slugs (batch boundaries
  // depend on when past reads ran) and left the old timestamp-titled pages
  // standing next to duplicates. With the day-page inventory, the census,
  // and range-coverage retirement in place, the replay's re-emissions now
  // retire the pages they supersede. Pages older than the 90-day backfill
  // window are never re-read and deliberately stay: they may hold history
  // Slack no longer serves.
  id: BRAIN_COLLECTOR_IDS.slackPublicChannels,
  displayName: 'Slack public channels',
  async isEnabled() {
    return isBrainSourceAvailable('slack');
  },
  async collect({ now, limit }) {
    return collectSlackPublicChannelMessages({ now, limit });
  },
  async backfill({ cursor }) {
    return backfillSlackHistoryStep(cursor);
  },
};
