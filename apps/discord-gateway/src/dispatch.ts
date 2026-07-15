import type { REST } from 'discord.js';
import { Routes } from 'discord.js';

import type {
  DiscordInboundEnvelope,
  DiscordInboundEventType,
} from './inbound-queue';

type RawDispatch = {
  t?: string | null;
  d?: unknown;
};

type RawMessage = {
  id?: string;
  channel_id?: string;
  guild_id?: string;
  content?: string;
  author?: { bot?: boolean };
  mentions?: Array<{ id?: string }>;
};

type RawInteraction = {
  id?: string;
  token?: string;
  type?: number;
  data?: { name?: string };
};

type DispatchDependencies = {
  rest: Pick<REST, 'post'>;
  enqueue: (envelope: DiscordInboundEnvelope) => Promise<boolean>;
  getBotUserId?: () => string | undefined;
  getCachedChannel?: (
    channelId: string,
  ) => DiscordCachedMessageChannel | undefined;
  /**
   * Forward an unmentioned guild message when Gateway channel metadata could
   * not be resolved. The durable API consumer performs its own authoritative
   * channel lookup and task-thread check.
   */
  enqueueUnknownGuildChannel?: boolean;
  now?: () => Date;
};

export type DiscordCachedMessageChannel = {
  id: string;
  type: number;
  guildId?: string;
  parentId?: string;
  ownerId?: string;
  name?: string;
  isThread: boolean;
};

function isBotMentioned(
  message: RawMessage,
  botUserId: string | undefined,
): boolean {
  if (!botUserId) return false;
  return (
    message.mentions?.some((mention) => mention.id === botUserId) === true ||
    message.content?.includes(`<@${botUserId}>`) === true ||
    message.content?.includes(`<@!${botUserId}>`) === true
  );
}

function enrichMessagePayload(
  message: RawMessage,
  channel: DiscordCachedMessageChannel | undefined,
): RawMessage & Record<string, unknown> {
  if (!channel) return message;
  return {
    ...message,
    channel: {
      id: channel.id,
      type: channel.type,
      ...(channel.guildId ? { guild_id: channel.guildId } : {}),
      ...(channel.parentId ? { parent_id: channel.parentId } : {}),
      ...(channel.ownerId ? { owner_id: channel.ownerId } : {}),
      ...(channel.name ? { name: channel.name } : {}),
    },
  };
}

function eventTypeFor(packet: RawDispatch): DiscordInboundEventType | null {
  if (packet.t === 'MESSAGE_CREATE') {
    return 'MESSAGE_CREATE';
  }
  if (packet.t === 'INTERACTION_CREATE') {
    return 'INTERACTION_CREATE';
  }
  return null;
}

async function deferInteraction(
  interaction: RawInteraction,
  rest: Pick<REST, 'post'>,
): Promise<boolean> {
  if (!interaction.id || !interaction.token) {
    return false;
  }

  let responseType: number | null = null;
  if (interaction.type === 2 || interaction.type === 5) {
    // Application command / modal submit: a later follow-up response.
    responseType = 5;
  } else if (interaction.type === 3) {
    // Message component: acknowledge without replacing the message yet.
    responseType = 6;
  }

  if (!responseType) {
    return false;
  }

  try {
    const commandName = interaction.data?.name?.toLowerCase();
    const ephemeral =
      interaction.type === 2 &&
      (commandName === 'link' || commandName === 'help');
    await rest.post(
      Routes.interactionCallback(interaction.id, interaction.token),
      {
        body: {
          type: responseType,
          ...(ephemeral && { data: { flags: 64 } }),
        },
      },
    );
    return true;
  } catch (error) {
    // A replay after the first Gateway process acknowledged but failed to
    // enqueue returns Discord code 40060. Network/5xx failures are ambiguous:
    // Discord may have accepted the acknowledgement before the response was
    // lost. In both cases the API must try to edit the original response first
    // and fall back only when Discord confirms that no response exists.
    const errorRecord =
      error && typeof error === 'object'
        ? (error as { code?: unknown; status?: unknown })
        : undefined;
    const status =
      typeof errorRecord?.status === 'number' ? errorRecord.status : undefined;
    const alreadyAcknowledged =
      errorRecord?.code === 40060 || errorRecord?.code === '40060';
    const acknowledgementMayExist =
      alreadyAcknowledged || status === undefined || status >= 500;
    console.warn(
      `[discord-gateway] could not defer interaction ${interaction.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return acknowledgementMayExist;
  }
}

export async function handleGatewayDispatch(
  packet: RawDispatch,
  dependencies: DispatchDependencies,
): Promise<'ignored' | 'duplicate' | 'enqueued'> {
  const eventType = eventTypeFor(packet);
  if (!eventType || !packet.d || typeof packet.d !== 'object') {
    return 'ignored';
  }

  if (eventType === 'MESSAGE_CREATE') {
    const message = packet.d as RawMessage;
    if (!message.id || message.author?.bot) {
      return 'ignored';
    }

    const cachedChannel = message.channel_id
      ? dependencies.getCachedChannel?.(message.channel_id)
      : undefined;
    const botUserId = dependencies.getBotUserId?.();
    // Discord sends every message from subscribed guild channels. Root
    // channels only start Roomote work when the bot is mentioned, while DMs
    // and task threads retain natural follow-ups without an extra mention.
    if (
      message.guild_id &&
      botUserId &&
      !isBotMentioned(message, botUserId) &&
      (cachedChannel?.isThread !== true ||
        cachedChannel.ownerId !== botUserId) &&
      !(
        dependencies.enqueueUnknownGuildChannel === true &&
        cachedChannel === undefined
      )
    ) {
      return 'ignored';
    }

    packet = {
      ...packet,
      d: enrichMessagePayload(message, cachedChannel),
    };
  }

  const payload = packet.d as RawMessage & RawInteraction;
  if (!payload.id) {
    return 'ignored';
  }

  const interactionDeferred =
    eventType === 'INTERACTION_CREATE'
      ? await deferInteraction(payload, dependencies.rest)
      : undefined;

  const enqueued = await dependencies.enqueue({
    eventId: payload.id,
    eventType,
    payload: packet.d,
    receivedAt: (dependencies.now?.() ?? new Date()).toISOString(),
    ...(interactionDeferred !== undefined && { interactionDeferred }),
  });

  return enqueued ? 'enqueued' : 'duplicate';
}
