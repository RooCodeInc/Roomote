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
  author?: { id?: string; bot?: boolean };
  webhook_id?: string;
  mentions?: Array<{ id?: string; username?: string; bot?: boolean }>;
  mention_roles?: string[];
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
  /** The bot's managed role id for a guild, when known. */
  getBotRoleId?: (guildId: string) => string | null | undefined;
  getBotUsername?: () => string | undefined;
  /**
   * Forward an unmentioned guild message when Gateway channel metadata could
   * not be resolved. The durable API consumer performs its own authoritative
   * channel lookup and task-thread check.
   */
  enqueueUnknownGuildChannel?: boolean;
  /**
   * Whether a channel is configured for channel auto-start. Messages in those
   * channels forward without a mention — including bot- and webhook-authored
   * ones (never Roomote's own) — so the API's auto-respond path can see them.
   */
  isAutoStartChannel?: (channelId: string) => boolean;
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

function isBotRoleMentioned(message: RawMessage, botRoleId: string): boolean {
  return (
    message.mention_roles?.includes(botRoleId) === true ||
    message.content?.includes(`<@&${botRoleId}>`) === true
  );
}

function normalizeBotRoleMention(
  message: RawMessage,
  botRoleId: string,
  bot: { id: string; username: string },
): RawMessage {
  const mentions = message.mentions ?? [];
  return {
    ...message,
    content: message.content?.replaceAll(`<@&${botRoleId}>`, `<@${bot.id}>`),
    // The injected entry must satisfy the API's full user schema, not just
    // carry an id.
    mentions: mentions.some((mention) => mention.id === bot.id)
      ? mentions
      : [...mentions, { id: bot.id, username: bot.username, bot: true }],
  };
}

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
    let message = packet.d as RawMessage;
    if (!message.id) {
      return 'ignored';
    }

    const cachedChannel = message.channel_id
      ? dependencies.getCachedChannel?.(message.channel_id)
      : undefined;
    const botUserId = dependencies.getBotUserId?.();
    // Task threads carry their own id as channel_id, so this only matches
    // top-level messages in a monitored channel; the API re-checks
    // authoritatively.
    const autoStartChannel = Boolean(
      message.channel_id &&
      dependencies.isAutoStartChannel?.(message.channel_id) === true,
    );
    const botAuthored =
      message.author?.bot === true || typeof message.webhook_id === 'string';
    if (botAuthored) {
      const isOwnMessage = Boolean(
        botUserId && message.author?.id === botUserId,
      );
      // Bot- and webhook-authored messages (deploy feeds, alert bots) only
      // matter to auto-respond channels; Roomote's own posts never re-enter.
      if (!autoStartChannel || isOwnMessage) {
        return 'ignored';
      }
    }
    // Discord's mention autocomplete often resolves a bot by its managed
    // role (same name as the bot), which arrives as mention_roles +
    // <@&role> content with an empty user-mention list. Normalize that form
    // to a canonical user mention so every downstream consumer (entry
    // gating, mention stripping) sees one shape.
    const botRoleId = message.guild_id
      ? dependencies.getBotRoleId?.(message.guild_id)
      : undefined;
    const botUsername = dependencies.getBotUsername?.();
    if (
      botUserId &&
      botUsername &&
      botRoleId &&
      isBotRoleMentioned(message, botRoleId)
    ) {
      message = normalizeBotRoleMention(message, botRoleId, {
        id: botUserId,
        username: botUsername,
      });
    }
    // Discord sends every message from subscribed guild channels. Root
    // channels only start Roomote work when the bot is mentioned — except
    // auto-respond channels, which forward every top-level message. Forward
    // all thread messages so the API's durable conversation lookup can retain
    // natural follow-ups even when Roomote did not create the Discord thread.
    if (
      message.guild_id &&
      botUserId &&
      !autoStartChannel &&
      !isBotMentioned(message, botUserId) &&
      cachedChannel?.isThread !== true &&
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
