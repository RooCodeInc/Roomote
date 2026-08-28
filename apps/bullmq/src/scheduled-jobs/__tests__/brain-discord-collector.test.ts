import { beforeEach, describe, expect, it, vi } from 'vitest';

const DISCORD_EPOCH_MS = 1_420_070_400_000n;

const workspace = vi.hoisted(() => ({
  messages: new Map<string, Array<Record<string, unknown>>>(),
  fetchCalls: [] as string[],
  tracked: [] as Array<{
    collectorId: string;
    itemId: string;
    slug: string;
    lastSeenAt: Date;
  }>,
  syncState: new Map<
    string,
    {
      watermark?: Date | null;
      backfillCursor?: string | null;
      backfillCompletedAt?: Date | null;
    }
  >(),
  available: true,
  providerEnabled: true,
  guildPageNextAfter: null as string | null,
  guilds: [] as Array<{ id: string; name: string; icon: null }>,
  installations: [] as Array<{ guildId: string }>,
  channels: [] as Array<{
    id: string;
    name: string;
    type: number;
    parentId?: string;
  }>,
  threads: [] as Array<{
    id: string;
    name: string;
    type: number;
    parentId?: string;
  }>,
}));

function snowflake(iso: string, sequence = 0): string {
  return (
    ((BigInt(Date.parse(iso)) - DISCORD_EPOCH_MS) << 22n) |
    BigInt(sequence)
  ).toString();
}

const provider = {
  getBotInfo: vi.fn(async () => ({ id: '999' })),
  listGuildsPage: vi.fn(async () => ({
    guilds: workspace.guilds,
    nextAfter: workspace.guildPageNextAfter,
  })),
  listPublicReadableGuildChannels: vi.fn(async () => workspace.channels),
  listGuildActiveThreads: vi.fn(async () => workspace.threads),
  fetchChannelMessages: vi.fn(
    async ({
      channelId,
      oldest,
      latest,
    }: {
      channelId: string;
      oldest?: string;
      latest?: string;
    }) => {
      workspace.fetchCalls.push(channelId);
      const messages = (workspace.messages.get(channelId) ?? []).filter(
        (message) =>
          (!oldest || BigInt(message.id as string) >= BigInt(oldest)) &&
          (!latest || BigInt(message.id as string) <= BigInt(latest)),
      );
      return {
        provider: 'discord' as const,
        channelId,
        messageCount: messages.length,
        messages,
      };
    },
  ),
};

vi.mock('@roomote/sdk/server', () => ({
  createDiscordCommunicationProviderFromRuntimeCredentials: vi.fn(async () =>
    workspace.providerEnabled ? provider : null,
  ),
  isBrainSourceAvailable: vi.fn(async () => workspace.available),
  listDiscordInstallations: vi.fn(async () => workspace.installations),
}));

vi.mock('@roomote/db/server', () => ({
  db: {
    query: {
      discordUserMappings: {
        findMany: vi.fn(async () => [
          {
            discordUserId: '200',
            user: {
              id: 'alice-id',
              name: 'Alice Example <alice@example.com>',
              createdAt: new Date('2026-01-01T00:00:00Z'),
              deletedAt: null,
            },
          },
        ]),
      },
    },
  },
  getBrainSyncState: vi.fn(
    async (_db: unknown, collectorId: string) =>
      workspace.syncState.get(collectorId) ?? null,
  ),
  listBrainCollectorItems: vi.fn(async () => workspace.tracked),
  listBrainCollectorItemsBySlugPrefix: vi.fn(
    async (_db: unknown, collectorId: string, prefix: string) =>
      workspace.tracked.filter(
        (item) =>
          item.collectorId === collectorId && item.itemId.startsWith(prefix),
      ),
  ),
}));

beforeEach(() => {
  workspace.messages.clear();
  workspace.fetchCalls = [];
  workspace.tracked = [];
  workspace.syncState.clear();
  workspace.available = true;
  workspace.providerEnabled = true;
  workspace.guildPageNextAfter = null;
  workspace.guilds = [{ id: '100', name: 'Community', icon: null }];
  workspace.installations = [{ guildId: '100' }];
  workspace.channels = [{ id: '300', name: 'general', type: 0 }];
  workspace.threads = [];
  vi.clearAllMocks();
  vi.resetModules();
});

describe('Discord public-channel Brain collector', () => {
  it('formats public channel and active public-thread messages deterministically', async () => {
    workspace.threads = [
      { id: '301', name: 'design', type: 11, parentId: '300' },
      { id: '302', name: 'private', type: 12, parentId: '300' },
      { id: '304', name: 'forum-post', type: 11, parentId: '303' },
    ];
    workspace.channels.push({ id: '303', name: 'ideas', type: 15 });
    workspace.messages.set('300', [
      {
        provider: 'discord',
        id: snowflake('2026-08-28T10:00:00Z'),
        user: '200',
        username: 'alice',
        text: 'A public decision',
        channelId: '300',
        fileCount: 1,
        files: [
          {
            id: '1',
            name: 'plan.pdf',
            mimeType: 'application/pdf',
            size: 10,
            url: 'https://cdn.discordapp.com/secret',
          },
        ],
      },
    ]);
    workspace.messages.set('301', [
      {
        provider: 'discord',
        id: snowflake('2026-08-28T11:00:00Z'),
        user: '201',
        username: 'bob',
        text: 'Thread reply',
        replyToMessageId: '123',
        channelId: '301',
        fileCount: 0,
      },
    ]);
    workspace.messages.set('304', [
      {
        provider: 'discord',
        id: snowflake('2026-08-28T11:30:00Z'),
        user: '201',
        username: 'bob',
        text: 'Forum context',
        channelId: '304',
        fileCount: 0,
      },
    ]);
    const { discordPublicChannelsCollector } =
      await import('../brain-collectors/discord-public-channels');

    const result = await discordPublicChannelsCollector.collect({
      since: null,
      now: new Date('2026-08-28T12:00:00Z'),
      limit: 100,
    });
    const content = result.pages.map((page) => page.content).join('\n');

    expect(result.pages.map((page) => page.slug)).toEqual([
      'discord/100/300/2026-08-28/000',
      'discord/100/threads/300/301/2026-08-28/000',
      'discord/100/threads/303/304/2026-08-28/000',
    ]);
    expect(content).toContain('[Alice Example](people/roomote-member-');
    expect(content).toContain('[attachments: plan.pdf]');
    expect(content).toContain('(reply to 123)');
    expect(content).not.toContain('alice@example.com');
    expect(content).not.toContain('cdn.discordapp.com/secret');
    expect(workspace.fetchCalls).not.toContain('302');
  });

  it('retires stale chunks after a complete empty-day read', async () => {
    workspace.tracked = [
      {
        collectorId: 'discord-public-channels:day-pages',
        itemId: 'discord/100/300/2026-08-28/000',
        slug: 'discord/100/300/2026-08-28/000',
        lastSeenAt: new Date('2026-08-28T00:00:00Z'),
      },
    ];
    const { discordPublicChannelsCollector } =
      await import('../brain-collectors/discord-public-channels');

    const result = await discordPublicChannelsCollector.collect({
      since: null,
      now: new Date('2026-08-28T12:00:00Z'),
      limit: 100,
    });

    expect(result.pageRetirements).toContainEqual({
      collectorId: 'discord-public-channels:day-pages',
      itemId: 'discord/100/300/2026-08-28/000',
      slug: 'discord/100/300/2026-08-28/000',
    });
  });

  it('preserves an archived public thread while its parent remains public', async () => {
    workspace.tracked = [
      {
        collectorId: 'discord-public-channels:day-pages',
        itemId: 'discord/100/threads/300/301/2026-08-20/000',
        slug: 'discord/100/threads/300/301/2026-08-20/000',
        lastSeenAt: new Date('2026-08-20T00:00:00Z'),
      },
    ];
    const { discordPublicChannelsCollector } =
      await import('../brain-collectors/discord-public-channels');

    const result = await discordPublicChannelsCollector.collect({
      since: null,
      now: new Date('2026-08-28T12:00:00Z'),
      limit: 100,
    });

    expect(result.pageRetirements).not.toContainEqual(
      expect.objectContaining({
        slug: 'discord/100/threads/300/301/2026-08-20/000',
      }),
    );
  });

  it('retires a channel after an authoritative public-permission scan excludes it', async () => {
    workspace.channels = [];
    workspace.tracked = [
      {
        collectorId: 'discord-public-channels:day-pages',
        itemId: 'discord/100/300/2026-08-20/000',
        slug: 'discord/100/300/2026-08-20/000',
        lastSeenAt: new Date('2026-08-20T00:00:00Z'),
      },
    ];
    const { discordPublicChannelsCollector } =
      await import('../brain-collectors/discord-public-channels');

    const result = await discordPublicChannelsCollector.collect({
      since: null,
      now: new Date('2026-08-28T12:00:00Z'),
      limit: 100,
    });

    expect(result.pageRetirements).toContainEqual(
      expect.objectContaining({
        slug: 'discord/100/300/2026-08-20/000',
      }),
    );
  });

  it('requeues deep history when a retired channel becomes public again', async () => {
    workspace.channels = [];
    workspace.tracked = [
      {
        collectorId: 'discord-public-channels:day-pages',
        itemId: 'discord/100/300/2026-08-20/000',
        slug: 'discord/100/300/2026-08-20/000',
        lastSeenAt: new Date('2026-08-20T00:00:00Z'),
      },
    ];
    let module = await import('../brain-collectors/discord-public-channels');
    const revoked = await module.discordPublicChannelsCollector.collect({
      since: null,
      now: new Date('2026-08-28T12:00:00Z'),
      limit: 100,
    });
    const revokedUpdate = revoked.stateUpdates?.find(
      (update) =>
        update.collectorId === 'discord-public-channels:revoked-partitions-v1',
    );
    expect(JSON.parse(revokedUpdate?.cursor ?? '{}')).toEqual({
      keys: ['100/300'],
    });

    workspace.syncState.set('discord-public-channels:revoked-partitions-v1', {
      backfillCursor: revokedUpdate!.cursor!,
    });
    workspace.syncState.set(module.discordPublicChannelsCollector.id, {
      backfillCompletedAt: new Date('2026-08-20T00:00:00Z'),
      backfillCursor: JSON.stringify({
        completed: ['100/300'],
        key: null,
        day: null,
      }),
    });
    workspace.tracked = [];
    workspace.channels = [{ id: '300', name: 'general', type: 0 }];
    vi.resetModules();
    module = await import('../brain-collectors/discord-public-channels');

    const restored = await module.discordPublicChannelsCollector.collect({
      since: null,
      now: new Date('2026-08-28T12:15:00Z'),
      limit: 100,
    });
    const pendingUpdate = restored.stateUpdates?.find(
      (update) =>
        update.collectorId === 'discord-public-channels:backfill-pending-v1',
    );

    expect(JSON.parse(pendingUpdate?.cursor ?? '{}')).toMatchObject({
      entries: [expect.objectContaining({ key: '100/300' })],
    });
    expect(restored.stateUpdates).toContainEqual({
      collectorId: module.discordPublicChannelsCollector.id,
      backfillCompletedAt: null,
    });
  });

  it('persists a day cursor for bounded history backfill', async () => {
    const { discordPublicChannelsCollector } =
      await import('../brain-collectors/discord-public-channels');
    workspace.syncState.set('discord-public-channels:backfill-pending-v1', {
      backfillCursor: JSON.stringify({
        entries: [
          {
            key: '100/300',
            guildId: '100',
            guildName: 'Community',
            channelId: '300',
            channelName: 'general',
            parentChannelId: null,
            parentChannelName: null,
            isThread: false,
          },
        ],
      }),
    });

    const result = await discordPublicChannelsCollector.backfill!({
      cursor: null,
      limit: 100,
    });
    const cursor = JSON.parse(result.nextCursor!) as {
      key: string;
      day: string;
    };

    expect(result.done).toBe(false);
    expect(cursor.key).toBe('100/300');
    expect(cursor.day).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(workspace.fetchCalls).toEqual(['300']);
  });

  it('re-arms a completed backfill when a new public channel appears', async () => {
    const { discordPublicChannelsCollector } =
      await import('../brain-collectors/discord-public-channels');
    workspace.syncState.set(discordPublicChannelsCollector.id, {
      backfillCompletedAt: new Date('2026-08-20T00:00:00Z'),
      backfillCursor: JSON.stringify({
        completed: [],
        key: null,
        day: null,
      }),
    });

    const result = await discordPublicChannelsCollector.collect({
      since: null,
      now: new Date('2026-08-28T12:00:00Z'),
      limit: 100,
    });

    expect(result.stateUpdates).toContainEqual({
      collectorId: discordPublicChannelsCollector.id,
      backfillCompletedAt: null,
    });
    const pending = result.stateUpdates?.find(
      (update) =>
        update.collectorId === 'discord-public-channels:backfill-pending-v1',
    );
    expect(JSON.parse(pending?.cursor ?? '{}')).toMatchObject({
      entries: [expect.objectContaining({ key: '100/300' })],
    });
  });

  it('catches up missed days from the per-channel watermark', async () => {
    workspace.syncState.set(
      'discord-public-channels:entity-timeline-v1:100/300',
      { watermark: new Date('2026-08-24T00:00:00Z') },
    );
    workspace.messages.set('300', [
      {
        provider: 'discord',
        id: snowflake('2026-08-24T10:00:00Z'),
        user: '200',
        username: 'alice',
        text: 'Missed during an outage',
        channelId: '300',
        fileCount: 0,
      },
    ]);
    const { discordPublicChannelsCollector } =
      await import('../brain-collectors/discord-public-channels');

    const result = await discordPublicChannelsCollector.collect({
      since: null,
      now: new Date('2026-08-28T12:00:00Z'),
      limit: 100,
    });

    expect(result.pages.map((page) => page.slug)).toContain(
      'discord/100/300/2026-08-24/000',
    );
    expect(result.stateUpdates).toContainEqual({
      collectorId: `${discordPublicChannelsCollector.id}:100/300`,
      watermark: new Date('2026-08-26T00:00:00Z'),
    });
  });

  it('advances a bounded durable guild-discovery cursor', async () => {
    workspace.guildPageNextAfter = '100';
    const { discordPublicChannelsCollector } =
      await import('../brain-collectors/discord-public-channels');

    const result = await discordPublicChannelsCollector.collect({
      since: null,
      now: new Date('2026-08-28T12:00:00Z'),
      limit: 100,
    });

    expect(provider.listGuildsPage).toHaveBeenCalledWith({ limit: 10 });
    expect(result.stateUpdates).toContainEqual({
      collectorId: 'discord-public-channels:guild-discovery',
      cursor: JSON.stringify({ after: '100' }),
    });
  });

  it('discovers channels only for active Discord installations', async () => {
    workspace.guilds = [
      { id: '100', name: 'Active', icon: null },
      { id: '101', name: 'Inactive', icon: null },
    ];
    workspace.installations = [{ guildId: '100' }];
    const { discordPublicChannelsCollector } =
      await import('../brain-collectors/discord-public-channels');

    await discordPublicChannelsCollector.collect({
      since: null,
      now: new Date('2026-08-28T12:00:00Z'),
      limit: 100,
    });

    expect(provider.listPublicReadableGuildChannels).toHaveBeenCalledTimes(1);
    expect(provider.listPublicReadableGuildChannels).toHaveBeenCalledWith({
      guildId: '100',
      userId: '999',
    });
    expect(provider.listGuildActiveThreads).toHaveBeenCalledWith('100');
    expect(provider.listGuildActiveThreads).not.toHaveBeenCalledWith('101');
  });

  it('retires indexed pages when a Discord installation is deactivated', async () => {
    workspace.guilds = [
      { id: '100', name: 'Active', icon: null },
      { id: '101', name: 'Inactive', icon: null },
    ];
    workspace.installations = [{ guildId: '100' }];
    workspace.tracked = [
      {
        collectorId: 'discord-public-channels:day-pages',
        itemId: 'discord/101/301/2026-08-20/000',
        slug: 'discord/101/301/2026-08-20/000',
        lastSeenAt: new Date('2026-08-20T00:00:00Z'),
      },
    ];
    const { discordPublicChannelsCollector } =
      await import('../brain-collectors/discord-public-channels');

    const result = await discordPublicChannelsCollector.collect({
      since: null,
      now: new Date('2026-08-28T12:00:00Z'),
      limit: 100,
    });

    expect(result.pageRetirements).toContainEqual({
      collectorId: 'discord-public-channels:day-pages',
      itemId: 'discord/101/301/2026-08-20/000',
      slug: 'discord/101/301/2026-08-20/000',
    });
    const revoked = result.stateUpdates?.find(
      (update) =>
        update.collectorId === 'discord-public-channels:revoked-partitions-v1',
    );
    expect(JSON.parse(revoked?.cursor ?? '{}')).toEqual({
      keys: ['101/301'],
    });
  });

  it('prunes pending backfill for deactivated installations', async () => {
    workspace.installations = [{ guildId: '100' }];
    workspace.syncState.set('discord-public-channels:backfill-pending-v1', {
      backfillCursor: JSON.stringify({
        entries: [
          {
            key: '101/301',
            guildId: '101',
            guildName: 'Inactive',
            channelId: '301',
            channelName: 'general',
            parentChannelId: null,
            parentChannelName: null,
            isThread: false,
          },
        ],
      }),
    });
    const { discordPublicChannelsCollector } =
      await import('../brain-collectors/discord-public-channels');

    const result = await discordPublicChannelsCollector.backfill!({
      cursor: null,
      limit: 100,
    });

    expect(result.done).toBe(true);
    expect(result.stateUpdates).toEqual([
      {
        collectorId: 'discord-public-channels:backfill-pending-v1',
        cursor: JSON.stringify({ entries: [] }),
      },
    ]);
    expect(workspace.fetchCalls).toEqual([]);
  });

  it('disables collection without credentials and preserves inventory', async () => {
    workspace.available = false;
    workspace.providerEnabled = false;
    workspace.tracked = [
      {
        collectorId: 'discord-public-channels:day-pages',
        itemId: 'discord/100/300/2026-08-20/000',
        slug: 'discord/100/300/2026-08-20/000',
        lastSeenAt: new Date('2026-08-20T00:00:00Z'),
      },
    ];
    const { discordPublicChannelsCollector } =
      await import('../brain-collectors/discord-public-channels');

    await expect(discordPublicChannelsCollector.isEnabled()).resolves.toBe(
      false,
    );
    expect(provider.listGuildsPage).not.toHaveBeenCalled();
  });

  it('bounds incremental history reads to ten channel partitions', async () => {
    workspace.channels = Array.from({ length: 12 }, (_, index) => ({
      id: String(300 + index),
      name: `channel-${index}`,
      type: 0,
    }));
    const { discordPublicChannelsCollector } =
      await import('../brain-collectors/discord-public-channels');

    await discordPublicChannelsCollector.collect({
      since: null,
      now: new Date('2026-08-28T12:00:00Z'),
      limit: 100,
    });

    expect(new Set(workspace.fetchCalls).size).toBe(10);
    expect(workspace.fetchCalls).toHaveLength(20);
  });
});
