import {
  ChannelType,
  Routes,
  type GatewayDispatchPayload,
  type REST,
} from 'discord.js';

import type { DiscordCachedMessageChannel } from './dispatch';

type RawChannel = {
  id?: string;
  type?: number;
  guild_id?: string;
  parent_id?: string | null;
  owner_id?: string | null;
  name?: string | null;
};

type RawGuild = {
  id?: string;
  channels?: RawChannel[];
  threads?: RawChannel[];
};

const THREAD_CHANNEL_TYPES = new Set<number>([
  ChannelType.AnnouncementThread,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
]);

function asCachedChannel(
  raw: RawChannel,
  fallbackGuildId?: string,
): DiscordCachedMessageChannel | null {
  if (!raw.id || typeof raw.type !== 'number') return null;
  const guildId = raw.guild_id ?? fallbackGuildId;
  return {
    id: raw.id,
    type: raw.type,
    ...(guildId ? { guildId } : {}),
    ...(raw.parent_id ? { parentId: raw.parent_id } : {}),
    ...(raw.owner_id ? { ownerId: raw.owner_id } : {}),
    ...(raw.name ? { name: raw.name } : {}),
    isThread: THREAD_CHANNEL_TYPES.has(raw.type),
  };
}

/** Maintains only the channel metadata needed to route Discord messages. */
export class DiscordGatewayChannelCache {
  private readonly channels = new Map<string, DiscordCachedMessageChannel>();

  get(channelId: string): DiscordCachedMessageChannel | undefined {
    return this.channels.get(channelId);
  }

  ingest(packet: GatewayDispatchPayload): void {
    const eventName = packet.t;
    if (!eventName || !packet.d || typeof packet.d !== 'object') return;

    if (eventName === 'GUILD_CREATE') {
      const guild = packet.d as RawGuild;
      for (const channel of [
        ...(guild.channels ?? []),
        ...(guild.threads ?? []),
      ]) {
        this.set(channel, guild.id);
      }
      return;
    }

    if (eventName === 'THREAD_LIST_SYNC') {
      const payload = packet.d as { guild_id?: string; threads?: RawChannel[] };
      for (const thread of payload.threads ?? []) {
        this.set(thread, payload.guild_id);
      }
      return;
    }

    if (
      eventName === 'CHANNEL_CREATE' ||
      eventName === 'CHANNEL_UPDATE' ||
      eventName === 'THREAD_CREATE' ||
      eventName === 'THREAD_UPDATE'
    ) {
      this.set(packet.d as RawChannel);
      return;
    }

    if (eventName === 'CHANNEL_DELETE' || eventName === 'THREAD_DELETE') {
      const channel = packet.d as RawChannel;
      if (channel.id) this.channels.delete(channel.id);
      return;
    }

    if (eventName === 'GUILD_DELETE') {
      const guild = packet.d as RawGuild;
      if (!guild.id) return;
      for (const [channelId, channel] of this.channels) {
        if (channel.guildId === guild.id) this.channels.delete(channelId);
      }
    }
  }

  async fetch(
    channelId: string,
    rest: Pick<REST, 'get'>,
  ): Promise<DiscordCachedMessageChannel | undefined> {
    const cached = this.channels.get(channelId);
    if (cached) return cached;

    const raw = (await rest.get(Routes.channel(channelId))) as RawChannel;
    return this.set(raw) ?? undefined;
  }

  private set(
    raw: RawChannel,
    fallbackGuildId?: string,
  ): DiscordCachedMessageChannel | null {
    const channel = asCachedChannel(raw, fallbackGuildId);
    if (channel) this.channels.set(channel.id, channel);
    return channel;
  }
}
