import type { DiscordCommunicationProvider } from '@roomote/communication/discord-provider';
import type { CommunicationMessage } from '@roomote/communication/provider';
import {
  db,
  getBrainSyncState,
  listBrainCollectorItems,
  listBrainCollectorItemsBySlugPrefix,
} from '@roomote/db/server';
import {
  createDiscordCommunicationProviderFromRuntimeCredentials,
  isBrainSourceAvailable,
} from '@roomote/sdk/server';
import {
  BRAIN_COLLECTOR_IDS,
  BRAIN_PAGE_TYPES,
  brainNamespacePrefix,
  buildDiscordMessagePermalink,
  renderBrainFrontmatter,
} from '@roomote/types';

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

const LOG_PREFIX = '[brainCollectors]';
const DISCORD_EPOCH_MS = 1_420_070_400_000n;
const DAY_MS = 24 * 60 * 60 * 1_000;
const DISCORD_HISTORY_PAGE_SIZE = 100;
const DISCORD_DAY_MAX_REQUESTS = 25;
const DISCORD_PAGE_MESSAGE_LIMIT = 200;
const DISCORD_INCREMENTAL_PARTITIONS_PER_PASS = 10;
const DISCORD_GUILDS_PER_DISCOVERY_PASS = 10;
const DISCORD_BACKFILL_DAYS = 90;
const DISCORD_INVENTORY_LIMIT = 10_000;
const DISCORD_INVENTORY_ID = 'discord-public-channels:day-pages';
const DISCORD_GUILD_DISCOVERY_STATE_ID =
  'discord-public-channels:guild-discovery';
const DISCORD_BACKFILL_PENDING_STATE_ID =
  'discord-public-channels:backfill-pending-v1';
const DISCORD_REVOKED_PARTITIONS_STATE_ID =
  'discord-public-channels:revoked-partitions-v1';
const DISCORD_DISCOVERY_CACHE_MS = 60_000;

const DISCORD_TEXT_CHANNEL_TYPES = new Set([0, 5]);
const DISCORD_PUBLIC_THREAD_PARENT_TYPES = new Set([0, 5, 15, 16]);
const DISCORD_PUBLIC_THREAD_TYPES = new Set([10, 11]);

type DiscordCollectionEntry = {
  key: string;
  guildId: string;
  guildName: string;
  channelId: string;
  channelName: string;
  parentChannelId: string | null;
  parentChannelName: string | null;
  isThread: boolean;
};

type DiscordDiscovery = {
  provider: DiscordCommunicationProvider;
  entries: DiscordCollectionEntry[];
  scannedGuildIds: Set<string>;
  readableChannelKeys: Set<string>;
  nextGuildCursor: DiscordGuildDiscoveryCursor;
};

type DiscordGuildDiscoveryCursor = {
  after: string | null;
};

type DiscordBackfillCursor = {
  completed: string[];
  key: string | null;
  day: string | null;
};

type DiscordBackfillPending = {
  entries: DiscordCollectionEntry[];
};

type DiscordRevokedPartitions = {
  keys: string[];
};

let discoveryCache: {
  loadedAt: number;
  cursorKey: string;
  value: DiscordDiscovery;
} | null = null;

export function discordSnowflakeToDate(id: string): Date | null {
  try {
    const milliseconds = (BigInt(id) >> 22n) + DISCORD_EPOCH_MS;
    const value = Number(milliseconds);
    return Number.isSafeInteger(value) ? new Date(value) : null;
  } catch {
    return null;
  }
}

function dateToDiscordSnowflake(date: Date): string {
  const milliseconds = BigInt(date.getTime()) - DISCORD_EPOCH_MS;
  return (milliseconds > 0n ? milliseconds << 22n : 0n).toString();
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function startOfUtcDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function shiftUtcDay(day: string, days: number): string {
  return utcDay(new Date(startOfUtcDay(day).getTime() + days * DAY_MS));
}

function normalizeMessageText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function discordDayPrefix(entry: DiscordCollectionEntry, day: string): string {
  const channelPath = entry.isThread
    ? `threads/${entry.parentChannelId}/${entry.channelId}`
    : entry.channelId;
  return `${brainNamespacePrefix('discord')}${entry.guildId}/${channelPath}/${day}/`.toLowerCase();
}

export function groupDiscordMessagesIntoDayPages(input: {
  entry: DiscordCollectionEntry;
  day: string;
  messages: CommunicationMessage[];
  people?: ReadonlyMap<string, PersonIdentityReference>;
}): CollectorPage[] {
  const messages = input.messages
    .filter(
      (message) =>
        discordSnowflakeToDate(message.id) &&
        (message.text.trim() || message.fileCount > 0),
    )
    .sort((left, right) => {
      try {
        const leftId = BigInt(left.id);
        const rightId = BigInt(right.id);
        return leftId === rightId ? 0 : leftId < rightId ? -1 : 1;
      } catch {
        return left.id.localeCompare(right.id);
      }
    });
  const channelLabel = input.entry.parentChannelName
    ? `#${input.entry.parentChannelName} / ${input.entry.channelName}`
    : `#${input.entry.channelName}`;
  const title = `${input.entry.guildName} / ${channelLabel} — ${input.day}`;
  const pages: CollectorPage[] = [];

  for (
    let start = 0;
    start < messages.length;
    start += DISCORD_PAGE_MESSAGE_LIMIT
  ) {
    const chunk = messages.slice(start, start + DISCORD_PAGE_MESSAGE_LIMIT);
    const people = new Set<string>();
    const lines = chunk.map((message) => {
      const at = discordSnowflakeToDate(message.id)!;
      const person = input.people?.get(message.user);
      if (person) people.add(person.slug);
      const author = person
        ? `[${person.title}](${person.slug}) (${message.user})`
        : `<${message.username ? `${message.username} (${message.user})` : message.user}>`;
      const text = normalizeMessageText(message.text);
      const attachments = (message.files ?? []).map((file) => file.name).sort();
      const details = [
        text,
        attachments.length > 0
          ? `[attachments: ${attachments.join(', ')}]`
          : '',
      ]
        .filter(Boolean)
        .join(' ');
      const permalink = buildDiscordMessagePermalink({
        guildId: input.entry.guildId,
        channelId: input.entry.channelId,
        messageId: message.id,
      });
      const reply = message.replyToMessageId
        ? ` (reply to ${message.replyToMessageId})`
        : '';
      return `- [${at.toISOString().slice(11, 16)}] ${author}${reply}: ${details}${permalink ? ` ([source](${permalink}))` : ''}`;
    });
    const index = Math.floor(start / DISCORD_PAGE_MESSAGE_LIMIT);
    const slug = `${discordDayPrefix(input.entry, input.day)}${String(index).padStart(3, '0')}`;

    pages.push({
      slug,
      title,
      content: [
        ...renderBrainFrontmatter({
          type: BRAIN_PAGE_TYPES.discordDay,
          title,
          created: input.day,
          fields: [
            `date: ${input.day}`,
            `guild_id: ${JSON.stringify(input.entry.guildId)}`,
            `channel_id: ${JSON.stringify(input.entry.channelId)}`,
            input.entry.isThread && 'thread: true',
          ],
        }),
        '',
        `# ${title}`,
        '',
        `Discord public ${input.entry.isThread ? 'thread' : 'channel'} ${channelLabel} in ${input.entry.guildName}, messages on ${input.day} (times UTC).`,
        '',
        ...lines,
      ].join('\n'),
      timelineEvidence: [...people].map((personSlug) => ({
        slug: personSlug,
        date: input.day,
        summary: 'Participated in a public Discord channel',
        source: `discord:channel-day:${input.entry.guildId}/${input.entry.channelId}/${input.day}`,
      })),
    });
  }

  return pages;
}

async function loadDiscordAuthorLabels(): Promise<
  Map<string, PersonIdentityReference>
> {
  try {
    const mappings = await db.query.discordUserMappings.findMany({
      with: {
        user: {
          columns: { id: true, name: true, createdAt: true, deletedAt: true },
        },
      },
    });
    return new Map(
      mappings.flatMap(({ discordUserId, user }) => {
        const title = brainSafeIdentityValue(user.name);
        return !user.deletedAt && title
          ? [
              [
                discordUserId,
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
      `${LOG_PREFIX} could not resolve Discord author names: ${error instanceof Error ? error.message : String(error)}`,
    );
    return new Map();
  }
}

function parseGuildDiscoveryCursor(
  raw: string | null,
): DiscordGuildDiscoveryCursor {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<DiscordGuildDiscoveryCursor>;
      return {
        after: typeof parsed.after === 'string' ? parsed.after : null,
      };
    } catch {
      // Restarting the guild census is safe; it only delays retirement.
    }
  }
  return { after: null };
}

async function discoverDiscordEntries(
  cursor: DiscordGuildDiscoveryCursor,
): Promise<DiscordDiscovery | null> {
  const now = Date.now();
  const cursorKey = JSON.stringify(cursor);
  if (
    discoveryCache &&
    discoveryCache.cursorKey === cursorKey &&
    now - discoveryCache.loadedAt < DISCORD_DISCOVERY_CACHE_MS
  ) {
    return discoveryCache.value;
  }

  const provider =
    await createDiscordCommunicationProviderFromRuntimeCredentials();
  if (!provider) return null;

  const [bot, guildPage] = await Promise.all([
    provider.getBotInfo(),
    provider.listGuildsPage({
      ...(cursor.after ? { after: cursor.after } : {}),
      limit: DISCORD_GUILDS_PER_DISCOVERY_PASS,
    }),
  ]);
  const guilds = guildPage.guilds;
  const entries: DiscordCollectionEntry[] = [];
  const scannedGuildIds = new Set<string>();
  const readableChannelKeys = new Set<string>();

  for (const guild of guilds) {
    try {
      const channels = await provider.listPublicReadableGuildChannels({
        guildId: guild.id,
        userId: bot.id,
      });
      const parents = new Map(
        channels
          .filter((channel) =>
            DISCORD_PUBLIC_THREAD_PARENT_TYPES.has(channel.type),
          )
          .map((channel) => [channel.id, channel] as const),
      );
      const activeThreads = await provider.listGuildActiveThreads(guild.id);

      for (const channel of parents.values()) {
        readableChannelKeys.add(`${guild.id}/${channel.id}`);
        if (!DISCORD_TEXT_CHANNEL_TYPES.has(channel.type)) continue;
        entries.push({
          key: `${guild.id}/${channel.id}`,
          guildId: guild.id,
          guildName: guild.name,
          channelId: channel.id,
          channelName: channel.name,
          parentChannelId: null,
          parentChannelName: null,
          isThread: false,
        });
      }
      for (const thread of activeThreads) {
        const parent = thread.parentId ? parents.get(thread.parentId) : null;
        if (!parent || !DISCORD_PUBLIC_THREAD_TYPES.has(thread.type)) continue;
        entries.push({
          key: `${guild.id}/${thread.id}`,
          guildId: guild.id,
          guildName: guild.name,
          channelId: thread.id,
          channelName: thread.name,
          parentChannelId: parent.id,
          parentChannelName: parent.name,
          isThread: true,
        });
      }
      scannedGuildIds.add(guild.id);
    } catch (error) {
      console.warn(
        `${LOG_PREFIX} Discord guild ${guild.id} discovery failed; preserving its existing pages: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  entries.sort((left, right) => left.key.localeCompare(right.key));
  const value = {
    provider,
    entries,
    scannedGuildIds,
    readableChannelKeys,
    nextGuildCursor: guildPage.nextAfter
      ? { after: guildPage.nextAfter }
      : { after: null },
  };
  discoveryCache = { loadedAt: now, cursorKey, value };
  return value;
}

async function fetchDiscordDay(input: {
  provider: DiscordCommunicationProvider;
  channelId: string;
  day: string;
}): Promise<{ messages: CommunicationMessage[]; complete: boolean }> {
  const start = startOfUtcDay(input.day);
  const end = new Date(start.getTime() + DAY_MS);
  const oldest = dateToDiscordSnowflake(start);
  let latest = (BigInt(dateToDiscordSnowflake(end)) - 1n).toString();
  const messages = new Map<string, CommunicationMessage>();

  for (let request = 0; request < DISCORD_DAY_MAX_REQUESTS; request++) {
    const page = await input.provider.fetchChannelMessages({
      channelId: input.channelId,
      oldest,
      latest,
    });
    for (const message of page.messages) messages.set(message.id, message);
    if (page.messages.length < DISCORD_HISTORY_PAGE_SIZE) {
      return { messages: [...messages.values()], complete: true };
    }

    const firstId = page.messages[0]?.id;
    if (!firstId) return { messages: [...messages.values()], complete: true };
    const next = BigInt(firstId) - 1n;
    if (next < BigInt(oldest)) {
      return { messages: [...messages.values()], complete: true };
    }
    latest = next.toString();
  }

  console.warn(
    `${LOG_PREFIX} Discord channel ${input.channelId} exceeded ${DISCORD_DAY_MAX_REQUESTS} history pages on ${input.day}; holding its checkpoint`,
  );
  return { messages: [], complete: false };
}

async function reconcileDiscordDay(input: {
  entry: DiscordCollectionEntry;
  day: string;
  pages: CollectorPage[];
  now: Date;
}): Promise<{
  itemUpdates: CollectorItemUpdate[];
  pageRetirements: CollectorPageRetirement[];
}> {
  const prefix = discordDayPrefix(input.entry, input.day);
  const tracked = await listBrainCollectorItemsBySlugPrefix(
    db,
    DISCORD_INVENTORY_ID,
    prefix,
    1_000,
  );
  const emitted = new Set(input.pages.map((page) => page.slug));

  return {
    itemUpdates: input.pages.map((page) => ({
      collectorId: DISCORD_INVENTORY_ID,
      itemId: page.slug,
      slug: page.slug,
      lastSeenAt: input.now,
    })),
    pageRetirements: tracked.flatMap((item) =>
      emitted.has(item.itemId)
        ? []
        : [
            {
              collectorId: DISCORD_INVENTORY_ID,
              itemId: item.itemId,
              slug: item.slug,
            },
          ],
    ),
  };
}

function parseInventoryEntry(slug: string): {
  guildId: string;
  channelId: string;
  parentChannelId: string | null;
  isThread: boolean;
} | null {
  const thread = slug.match(/^discord\/([^/]+)\/threads\/([^/]+)\/([^/]+)\//u);
  if (thread) {
    return {
      guildId: thread[1]!,
      parentChannelId: thread[2]!,
      channelId: thread[3]!,
      isThread: true,
    };
  }
  const channel = slug.match(/^discord\/([^/]+)\/([^/]+)\//u);
  return channel
    ? {
        guildId: channel[1]!,
        channelId: channel[2]!,
        parentChannelId: null,
        isThread: false,
      }
    : null;
}

async function collectInaccessiblePageRetirements(
  discovery: DiscordDiscovery | null,
  limit: number,
): Promise<{
  retirements: CollectorPageRetirement[];
  ineligibleKeys: Set<string>;
}> {
  const tracked = await listBrainCollectorItems(
    db,
    DISCORD_INVENTORY_ID,
    DISCORD_INVENTORY_LIMIT,
  );
  if (tracked.length === DISCORD_INVENTORY_LIMIT) {
    console.warn(
      `${LOG_PREFIX} Discord day-page inventory reached its ${DISCORD_INVENTORY_LIMIT} row cleanup scan bound`,
    );
  }
  const active = new Set(discovery?.entries.map((entry) => entry.key) ?? []);

  const ineligibleKeys = new Set<string>();
  const retirements = tracked
    .filter((item) => {
      const parsed = parseInventoryEntry(item.slug);
      if (!parsed) return false;
      if (!discovery) return false;
      if (!discovery.scannedGuildIds.has(parsed.guildId)) return false;
      if (active.has(`${parsed.guildId}/${parsed.channelId}`)) return false;
      if (parsed.isThread && parsed.parentChannelId) {
        // Discord omits archived public threads from this bounded discovery
        // pass, but they remain readable. Preserve them while their parent is
        // public; losing parent visibility is authoritative removal.
        const ineligible = !discovery.readableChannelKeys.has(
          `${parsed.guildId}/${parsed.parentChannelId}`,
        );
        if (ineligible) {
          ineligibleKeys.add(`${parsed.guildId}/${parsed.channelId}`);
        }
        return ineligible;
      }
      ineligibleKeys.add(`${parsed.guildId}/${parsed.channelId}`);
      return true;
    })
    .slice(0, limit)
    .map((item) => ({
      collectorId: DISCORD_INVENTORY_ID,
      itemId: item.itemId,
      slug: item.slug,
    }));
  return { retirements, ineligibleKeys };
}

function parseBackfillCursor(raw: string | null): DiscordBackfillCursor {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<DiscordBackfillCursor>;
      return {
        completed: Array.isArray(parsed.completed)
          ? parsed.completed.filter(
              (entry): entry is string => typeof entry === 'string',
            )
          : [],
        key: typeof parsed.key === 'string' ? parsed.key : null,
        day: typeof parsed.day === 'string' ? parsed.day : null,
      };
    } catch {
      // Restarting is safe because page slugs are stable upserts.
    }
  }
  return { completed: [], key: null, day: null };
}

function parseBackfillPending(raw: string | null): DiscordCollectionEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Partial<DiscordBackfillPending>;
    return Array.isArray(parsed.entries)
      ? parsed.entries.filter(
          (entry): entry is DiscordCollectionEntry =>
            typeof entry === 'object' &&
            entry !== null &&
            typeof entry.key === 'string' &&
            typeof entry.guildId === 'string' &&
            typeof entry.guildName === 'string' &&
            typeof entry.channelId === 'string' &&
            typeof entry.channelName === 'string' &&
            (typeof entry.parentChannelId === 'string' ||
              entry.parentChannelId === null) &&
            (typeof entry.parentChannelName === 'string' ||
              entry.parentChannelName === null) &&
            typeof entry.isThread === 'boolean',
        )
      : [];
  } catch {
    return [];
  }
}

function serializeBackfillPending(entries: DiscordCollectionEntry[]): string {
  return JSON.stringify({
    entries: [...entries].sort((left, right) =>
      left.key.localeCompare(right.key),
    ),
  } satisfies DiscordBackfillPending);
}

function parseRevokedPartitions(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as Partial<DiscordRevokedPartitions>;
    return new Set(
      Array.isArray(parsed.keys)
        ? parsed.keys.filter((key): key is string => typeof key === 'string')
        : [],
    );
  } catch {
    return new Set();
  }
}

function serializeRevokedPartitions(keys: ReadonlySet<string>): string {
  return JSON.stringify({
    keys: [...keys].sort(),
  } satisfies DiscordRevokedPartitions);
}

function pendingEntryRemainsEligible(
  entry: DiscordCollectionEntry,
  discovery: DiscordDiscovery,
  activeKeys: ReadonlySet<string>,
): boolean {
  if (!discovery.scannedGuildIds.has(entry.guildId)) return true;
  if (activeKeys.has(entry.key)) return true;
  return Boolean(
    entry.isThread &&
    entry.parentChannelId &&
    discovery.readableChannelKeys.has(
      `${entry.guildId}/${entry.parentChannelId}`,
    ),
  );
}

async function collectDiscordIncremental(input: {
  now: Date;
  limit: number;
}): Promise<CollectorResult> {
  const guildDiscoveryState = await getBrainSyncState(
    db,
    DISCORD_GUILD_DISCOVERY_STATE_ID,
  );
  const discovery = await discoverDiscordEntries(
    parseGuildDiscoveryCursor(guildDiscoveryState?.backfillCursor ?? null),
  );
  const inaccessible = await collectInaccessiblePageRetirements(
    discovery,
    input.limit,
  );
  const pageRetirements = inaccessible.retirements;
  if (!discovery) {
    return { pages: [], nextSince: null, pageRetirements };
  }

  const [people, pendingState, backfillState, revokedState] = await Promise.all(
    [
      loadDiscordAuthorLabels(),
      getBrainSyncState(db, DISCORD_BACKFILL_PENDING_STATE_ID),
      getBrainSyncState(db, discordPublicChannelsCollector.id),
      getBrainSyncState(db, DISCORD_REVOKED_PARTITIONS_STATE_ID),
    ],
  );
  const completedBackfills = new Set(
    parseBackfillCursor(backfillState?.backfillCursor ?? null).completed,
  );
  const activeKeys = new Set(discovery.entries.map((entry) => entry.key));
  const revoked = parseRevokedPartitions(revokedState?.backfillCursor ?? null);
  for (const key of inaccessible.ineligibleKeys) revoked.add(key);
  const pendingByKey = new Map(
    parseBackfillPending(pendingState?.backfillCursor ?? null)
      .filter((entry) =>
        pendingEntryRemainsEligible(entry, discovery, activeKeys),
      )
      .map((entry) => [entry.key, entry] as const),
  );
  for (const entry of discovery.entries) {
    if (!completedBackfills.has(entry.key) || revoked.has(entry.key)) {
      pendingByKey.set(entry.key, entry);
      revoked.delete(entry.key);
    }
  }
  const pendingCursor = serializeBackfillPending([...pendingByKey.values()]);
  const revokedCursor = serializeRevokedPartitions(revoked);
  const entries = await Promise.all(
    discovery.entries.map(async (entry) => ({
      ...entry,
      state: await getBrainSyncState(
        db,
        `${discordPublicChannelsCollector.id}:${entry.key}`,
      ),
    })),
  );
  entries.sort(
    (left, right) =>
      (left.state?.watermark?.getTime() ?? 0) -
        (right.state?.watermark?.getTime() ?? 0) ||
      left.key.localeCompare(right.key),
  );

  const pages: CollectorPage[] = [];
  const itemUpdates: CollectorItemUpdate[] = [];
  const stateUpdates: CollectorStateUpdate[] = discovery
    ? [
        {
          collectorId: DISCORD_GUILD_DISCOVERY_STATE_ID,
          cursor: JSON.stringify(discovery.nextGuildCursor),
        },
      ]
    : [];
  if (pendingCursor !== (pendingState?.backfillCursor ?? null)) {
    stateUpdates.push({
      collectorId: DISCORD_BACKFILL_PENDING_STATE_ID,
      cursor: pendingCursor,
    });
  }
  if (revokedCursor !== (revokedState?.backfillCursor ?? null)) {
    stateUpdates.push({
      collectorId: DISCORD_REVOKED_PARTITIONS_STATE_ID,
      cursor: revokedCursor,
    });
  }
  const today = utcDay(input.now);
  const recentStart = shiftUtcDay(today, -1);

  for (const entry of entries.slice(
    0,
    DISCORD_INCREMENTAL_PARTITIONS_PER_PASS,
  )) {
    const entryPages: CollectorPage[] = [];
    const entryUpdates: CollectorItemUpdate[] = [];
    const entryRetirements: CollectorPageRetirement[] = [];
    let complete = true;
    const watermarkDay = entry.state?.watermark
      ? utcDay(entry.state.watermark)
      : recentStart;
    const startDay = watermarkDay < recentStart ? watermarkDay : recentStart;
    const days = [startDay, shiftUtcDay(startDay, 1)].filter(
      (day) => day <= today,
    );

    for (const day of days) {
      try {
        const fetched = await fetchDiscordDay({
          provider: discovery.provider,
          channelId: entry.channelId,
          day,
        });
        if (!fetched.complete) {
          complete = false;
          break;
        }
        const dayPages = groupDiscordMessagesIntoDayPages({
          entry,
          day,
          messages: fetched.messages,
          people,
        });
        const reconciled = await reconcileDiscordDay({
          entry,
          day,
          pages: dayPages,
          now: input.now,
        });
        entryPages.push(...dayPages);
        entryUpdates.push(...reconciled.itemUpdates);
        entryRetirements.push(...reconciled.pageRetirements);
      } catch (error) {
        console.warn(
          `${LOG_PREFIX} Discord channel ${entry.channelId} history read failed; preserving its pages and checkpoint: ${error instanceof Error ? error.message : String(error)}`,
        );
        complete = false;
        break;
      }
    }

    if (!complete || pages.length + entryPages.length > input.limit) continue;
    pages.push(...entryPages);
    itemUpdates.push(...entryUpdates);
    pageRetirements.push(...entryRetirements);
    stateUpdates.push({
      collectorId: `${discordPublicChannelsCollector.id}:${entry.key}`,
      watermark:
        days.at(-1) === today
          ? input.now
          : startOfUtcDay(shiftUtcDay(days.at(-1)!, 1)),
    });
  }

  if (backfillState?.backfillCompletedAt && pendingByKey.size > 0) {
    stateUpdates.push({
      collectorId: discordPublicChannelsCollector.id,
      backfillCompletedAt: null,
    });
  }

  return {
    pages,
    nextSince: null,
    stateUpdates,
    itemUpdates,
    pageRetirements,
  };
}

async function backfillDiscordHistory(rawCursor: string | null): Promise<{
  pages: CollectorPage[];
  nextCursor: string | null;
  done: boolean;
  stateUpdates?: CollectorStateUpdate[];
  itemUpdates?: CollectorItemUpdate[];
  pageRetirements?: CollectorPageRetirement[];
}> {
  const noProgress = { pages: [], nextCursor: rawCursor, done: false };
  const [provider, pendingState] = await Promise.all([
    discoveryCache?.value.provider ??
      createDiscordCommunicationProviderFromRuntimeCredentials(),
    getBrainSyncState(db, DISCORD_BACKFILL_PENDING_STATE_ID),
  ]);
  if (!provider) return noProgress;

  const state = parseBackfillCursor(rawCursor);
  const completed = new Set(state.completed);
  const pending = parseBackfillPending(pendingState?.backfillCursor ?? null);
  const entry =
    (state.key
      ? pending.find((candidate) => candidate.key === state.key)
      : null) ?? pending[0];

  if (!entry) {
    return {
      pages: [],
      nextCursor: JSON.stringify({
        completed: [...completed].sort(),
        key: null,
        day: null,
      } satisfies DiscordBackfillCursor),
      done: true,
    };
  }

  const yesterday = shiftUtcDay(utcDay(new Date()), -1);
  const oldest = shiftUtcDay(yesterday, -(DISCORD_BACKFILL_DAYS - 1));
  const day = state.key === entry.key && state.day ? state.day : yesterday;
  const fetched = await fetchDiscordDay({
    provider,
    channelId: entry.channelId,
    day,
  });
  if (!fetched.complete) return noProgress;

  const people = await loadDiscordAuthorLabels();
  const pages = groupDiscordMessagesIntoDayPages({
    entry,
    day,
    messages: fetched.messages,
    people,
  });
  const reconciled = await reconcileDiscordDay({
    entry,
    day,
    pages,
    now: new Date(),
  });
  const nextDay = shiftUtcDay(day, -1);

  if (nextDay >= oldest) {
    return {
      pages,
      nextCursor: JSON.stringify({
        completed: [...completed].sort(),
        key: entry.key,
        day: nextDay,
      } satisfies DiscordBackfillCursor),
      done: false,
      ...reconciled,
    };
  }

  completed.add(entry.key);
  const remainingPending = pending.filter(
    (candidate) => candidate.key !== entry.key,
  );
  return {
    pages,
    nextCursor: JSON.stringify({
      completed: [...completed].sort(),
      key: null,
      day: null,
    } satisfies DiscordBackfillCursor),
    done: false,
    stateUpdates: [
      {
        collectorId: DISCORD_BACKFILL_PENDING_STATE_ID,
        cursor: serializeBackfillPending(remainingPending),
      },
    ],
    ...reconciled,
  };
}

export const discordPublicChannelsCollector: BrainCollector = {
  id: BRAIN_COLLECTOR_IDS.discordPublicChannels,
  displayName: 'Discord public channels',
  async isEnabled() {
    return isBrainSourceAvailable('discord');
  },
  collect({ now, limit }) {
    return collectDiscordIncremental({ now, limit });
  },
  backfill({ cursor }) {
    return backfillDiscordHistory(cursor);
  },
};
