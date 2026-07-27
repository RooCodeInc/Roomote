import { DiscordApiError } from '@roomote/communication/discord-provider';
import type {
  DiscordChannel,
  DiscordCommunicationProvider,
} from '@roomote/communication/discord-provider';
import type { CommunicationMessage } from '@roomote/communication/provider';
import { db, desc, discordUserMappings, eq } from '@roomote/db/server';
import { createDiscordCommunicationProviderFromRuntimeCredentials } from '@roomote/sdk/server';
import {
  getCommunicationChannelFromTaskPayload,
  getCommunicationProviderFromTaskPayload,
  parseDiscordMessagePermalink,
} from '@roomote/types';

import { McpProxyError } from './proxy-utils';

const DISCORD_SNOWFLAKE_REGEX = /^\d{1,30}$/;

type DiscordLookupMessage = {
  id: string;
  user: string;
  username?: string;
  botId?: string;
  text: string;
  fileCount: number;
  files?: Array<{
    id: string;
    name: string;
    mimeType: string;
    size: number;
    url?: string;
  }>;
};

type DiscordThreadLookupPayload = {
  channelId: string;
  requestedMessageId: string;
  threadId: string;
  matchedMessageIndex: number;
  messageCount: number;
  messages: DiscordLookupMessage[];
};

type DiscordChannelMessagesPayload = {
  channelId: string;
  requestedOldest?: string;
  requestedLatest?: string;
  messageCount: number;
  messages: DiscordLookupMessage[];
};

type DiscordLookupTaskRun = {
  payload: unknown;
  actingUserId?: string | null;
};

function normalizeDiscordLookupMessages(
  messages: CommunicationMessage[],
): DiscordLookupMessage[] {
  return messages.map((message) => ({
    id: message.id,
    user: message.user,
    ...(message.username ? { username: message.username } : {}),
    ...(message.botId ? { botId: message.botId } : {}),
    text: message.text,
    fileCount: message.fileCount,
    ...(message.files?.length
      ? {
          files: message.files.map((file) => ({
            id: file.id,
            name: file.name,
            mimeType: file.mimeType,
            size: file.size,
            ...(file.url ? { url: file.url } : {}),
          })),
        }
      : {}),
  }));
}

function normalizeDiscordSnowflake(
  value: string | undefined,
  fieldName: string,
): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!DISCORD_SNOWFLAKE_REGEX.test(trimmed)) {
    throw new McpProxyError(400, `${fieldName} must be a Discord snowflake id`);
  }
  return trimmed;
}

export function normalizeDiscordChannelTarget(
  rawChannel: string,
): { value: string } | { error: string } | null {
  const trimmed = rawChannel.trim();
  if (!trimmed) return null;

  const fromLink = parseDiscordMessagePermalink(trimmed);
  if (fromLink) {
    return { value: fromLink.channelId };
  }

  if (DISCORD_SNOWFLAKE_REGEX.test(trimmed)) {
    return { value: trimmed };
  }

  return {
    error:
      'channel must be a Discord channel/thread id or a discord.com message link',
  };
}

function getDiscordOriginChannel(
  taskRun?: DiscordLookupTaskRun | null,
): string | null {
  if (!taskRun) return null;
  const provider = getCommunicationProviderFromTaskPayload(taskRun.payload);
  if (provider && provider !== 'discord') return null;
  return getCommunicationChannelFromTaskPayload(taskRun.payload);
}

async function resolveDiscordProvider(): Promise<DiscordCommunicationProvider> {
  const provider =
    await createDiscordCommunicationProviderFromRuntimeCredentials();
  if (!provider) {
    throw new McpProxyError(
      404,
      'No Discord bot token is configured for this deployment',
    );
  }
  return provider;
}

async function resolveActingDiscordUserId(
  actingUserId?: string | null,
): Promise<string | null> {
  if (!actingUserId?.trim()) return null;
  const mapping = await db.query.discordUserMappings.findFirst({
    columns: { discordUserId: true },
    where: eq(discordUserMappings.userId, actingUserId),
    orderBy: [desc(discordUserMappings.updatedAt)],
  });
  return mapping?.discordUserId ?? null;
}

export async function assertDiscordChannelAccess(options: {
  provider: DiscordCommunicationProvider;
  channelId: string;
  isExplicitChannel: boolean;
  actingUserId?: string | null;
  requireHistoryPermission?: boolean;
}): Promise<DiscordChannel> {
  let channel;
  try {
    channel = await options.provider.getChannel(options.channelId);
  } catch (error) {
    if (error instanceof DiscordApiError && error.status === 404) {
      throw new McpProxyError(
        404,
        `Discord channel ${options.channelId} was not found or the bot cannot access it`,
      );
    }
    if (error instanceof DiscordApiError && error.status === 403) {
      throw new McpProxyError(
        403,
        `Discord bot cannot access channel ${options.channelId}`,
      );
    }
    throw new McpProxyError(
      502,
      `Could not resolve Discord channel ${options.channelId}`,
    );
  }

  if (channel.guildId && options.requireHistoryPermission) {
    try {
      const diagnostics = await options.provider.diagnoseChannelPermissions({
        guildId: channel.guildId,
        channelId: options.channelId,
      });
      if (!diagnostics.permissions.view_channel) {
        throw new McpProxyError(
          403,
          `Discord bot cannot view channel ${options.channelId}`,
        );
      }
      if (!diagnostics.permissions.read_message_history) {
        throw new McpProxyError(
          403,
          `Discord bot cannot read message history in channel ${options.channelId}`,
        );
      }
    } catch (error) {
      if (error instanceof McpProxyError) throw error;
      // Permission diagnose is best-effort; fetch failures still surface later.
    }
  }

  if (!options.isExplicitChannel) {
    return channel;
  }

  const linkedDiscordUserId = await resolveActingDiscordUserId(
    options.actingUserId,
  );
  if (!linkedDiscordUserId) {
    throw new McpProxyError(
      403,
      'Explicit Discord lookup requires the acting user to have a linked Discord account.',
    );
  }

  if (!channel.guildId) {
    // DMs and group DMs: linked-account gate above is the access control.
    return channel;
  }

  const hasChannelAccess = await options.provider.canUserAccessChannel({
    guildId: channel.guildId,
    channelId: options.channelId,
    userId: linkedDiscordUserId,
  });
  if (hasChannelAccess === false) {
    throw new McpProxyError(
      403,
      `Linked Discord user cannot access channel ${options.channelId}`,
    );
  }
  if (hasChannelAccess === null) {
    throw new McpProxyError(
      502,
      `Could not verify linked Discord user access for channel ${options.channelId}`,
    );
  }

  return channel;
}

async function resolveDiscordLookupChannel(options: {
  channel?: string;
  messageLink?: string;
  messageId?: string;
  taskRun?: DiscordLookupTaskRun | null;
  requireHistoryPermission?: boolean;
}): Promise<{
  provider: DiscordCommunicationProvider;
  channelId: string;
  messageId: string | null;
  isExplicitChannel: boolean;
}> {
  const originChannel = getDiscordOriginChannel(options.taskRun);
  const actingUserId =
    typeof options.taskRun?.actingUserId === 'string' &&
    options.taskRun.actingUserId.trim().length > 0
      ? options.taskRun.actingUserId
      : null;

  const linkRaw = options.messageLink?.trim() || options.channel?.trim() || '';
  const parsedLink = linkRaw ? parseDiscordMessagePermalink(linkRaw) : null;

  let channelId: string | null = null;
  let messageId = normalizeDiscordSnowflake(options.messageId, 'messageId');

  if (parsedLink) {
    channelId = parsedLink.channelId;
    if (parsedLink.messageId) {
      messageId = parsedLink.messageId;
    }
  } else if (options.channel?.trim()) {
    const channelTarget = normalizeDiscordChannelTarget(options.channel);
    if (!channelTarget) {
      channelId = null;
    } else if ('error' in channelTarget) {
      throw new McpProxyError(400, channelTarget.error);
    } else {
      channelId = channelTarget.value;
    }
  } else {
    channelId = originChannel;
  }

  if (!channelId) {
    throw new McpProxyError(
      400,
      'channel or messageLink is required when Discord lookup is not running from a Discord-originated job',
    );
  }

  const isExplicitChannel = Boolean(
    channelId && (!originChannel || channelId !== originChannel),
  );

  const provider = await resolveDiscordProvider();
  await assertDiscordChannelAccess({
    provider,
    channelId,
    isExplicitChannel,
    actingUserId,
    requireHistoryPermission: options.requireHistoryPermission,
  });

  return {
    provider,
    channelId,
    messageId,
    isExplicitChannel,
  };
}

export async function lookupDiscordThread(options: {
  channel?: string;
  messageId?: string;
  messageLink?: string;
  taskRun?: DiscordLookupTaskRun | null;
  actingDiscordMembershipUserId?: string | null;
}): Promise<DiscordThreadLookupPayload> {
  const taskRun: DiscordLookupTaskRun | null | undefined = options.taskRun
    ? options.taskRun
    : options.actingDiscordMembershipUserId
      ? {
          payload: {},
          actingUserId: options.actingDiscordMembershipUserId,
        }
      : options.taskRun;

  const { provider, channelId, messageId } = await resolveDiscordLookupChannel({
    channel: options.channel,
    messageLink: options.messageLink,
    messageId: options.messageId,
    taskRun,
  });

  if (!messageId) {
    throw new McpProxyError(
      400,
      'messageId or a Discord message link that includes a message id is required',
    );
  }

  let result;
  try {
    result = await provider.fetchThreadMessages({
      channelId,
      messageId,
    });
  } catch {
    throw new McpProxyError(
      502,
      `Discord thread for message ${messageId} could not be fetched from channel ${channelId}`,
    );
  }

  if (result.matchedMessageIndex < 0 || result.messageCount === 0) {
    throw new McpProxyError(
      404,
      `Discord message ${messageId} was not found in channel ${channelId}`,
    );
  }

  const messages = normalizeDiscordLookupMessages(result.messages);
  return {
    channelId: result.channelId,
    requestedMessageId: messageId,
    threadId: result.threadId,
    matchedMessageIndex: result.matchedMessageIndex,
    messageCount: messages.length,
    messages,
  };
}

export async function lookupDiscordChannelMessages(options: {
  channel?: string;
  oldest?: string;
  latest?: string;
  taskRun?: DiscordLookupTaskRun | null;
  actingDiscordMembershipUserId?: string | null;
}): Promise<DiscordChannelMessagesPayload> {
  const oldest = normalizeDiscordSnowflake(options.oldest, 'oldest');
  const latest = normalizeDiscordSnowflake(options.latest, 'latest');

  if (oldest && latest) {
    try {
      if (BigInt(oldest) > BigInt(latest)) {
        throw new McpProxyError(
          400,
          'oldest must be less than or equal to latest',
        );
      }
    } catch (error) {
      if (error instanceof McpProxyError) throw error;
      throw new McpProxyError(
        400,
        'oldest and latest must be Discord snowflakes',
      );
    }
  }

  const taskRun: DiscordLookupTaskRun | null | undefined = options.taskRun
    ? options.taskRun
    : options.actingDiscordMembershipUserId
      ? {
          payload: {},
          actingUserId: options.actingDiscordMembershipUserId,
        }
      : options.taskRun;

  const { provider, channelId } = await resolveDiscordLookupChannel({
    channel: options.channel,
    taskRun,
    requireHistoryPermission: true,
  });

  let messages: CommunicationMessage[];
  try {
    const result = await provider.fetchChannelMessages({
      channelId,
      ...(oldest ? { oldest } : {}),
      ...(latest ? { latest } : {}),
    });
    messages = result.messages;
  } catch {
    throw new McpProxyError(
      502,
      `Discord channel ${channelId} could not be fetched from Discord`,
    );
  }

  const normalized = normalizeDiscordLookupMessages(messages);
  return {
    channelId,
    ...(oldest ? { requestedOldest: oldest } : {}),
    ...(latest ? { requestedLatest: latest } : {}),
    messageCount: normalized.length,
    messages: normalized,
  };
}
